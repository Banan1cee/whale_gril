'use strict';

/**
 * DeepSeek 客户端（兼容 OpenAI 的 /chat/completions 协议）。
 * 只用 Node 内置模块，支持流式与非流式，失败时抛带「鲸鱼娘口吻」提示的 LlmError。
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { resolveRuntime, maskKey } = require('../infra/config');

const FRIENDLY = {
  nokey: '呜…人家还没拿到深海的钥匙（API Key），去右上角「设置」里填一下吧 (｡•́︿•̀｡)',
  401: '呜…人家的深海钥匙（API Key）好像不对，去设置里换一把吧 (´･_･`)',
  402: '深海算力余额用完啦…去服务商那边充值一下下嘛',
  403: '这扇门人家推不开（403），可能是 Key 没权限哦',
  429: '这家的额度/频率用完了（HTTP 429）。千问常见是 qwen-turbo 免费额度用完，换 qwen-flash 或 qwen-plus 试试；别的服务商就是额度或限流。',
  404: '这个模型名服务商用不了（HTTP 404）。千问的话换成 qwen-flash / qwen-plus / qwen-turbo 这三个之一。',
  network: '信号被洋流卷走了…再说一次好不好？',
  timeout: '人家潜得太深，回应慢了…等一下下再问我一次？',
  empty: '咕噜…这次只吐出了个空泡泡，再说一遍好不好？',
  default: '呜…深海线路打结了，等会儿再来找人家嘛 (｡•́︿•̀｡)',
};

class LlmError extends Error {
  constructor(userMessage, { code = 'unknown', status = 0, retryable = false, detail = '' } = {}) {
    super(detail || userMessage);
    this.name = 'LlmError';
    this.userMessage = userMessage || FRIENDLY.default;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function friendlyForStatus(status, detail = '') {
  if (status === 401) return FRIENDLY[401];
  if (status === 402) return FRIENDLY[402];
  if (status === 403) return FRIENDLY[403];
  if (status === 429) return FRIENDLY[429];
  // 404 多半是模型名不在这个账号的可用列表里（千问的 qwen-max-latest / qwen3-max 就是这种）
  if (status === 404 && /model/i.test(String(detail || ''))) return FRIENDLY[404];
  if (status >= 500) return FRIENDLY.default;
  return FRIENDLY.default;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const done = (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      if (err) reject(err); else resolve();
    };
    const abort = () => done(new LlmError('aborted', { code: 'aborted' }));
    const timer = setTimeout(() => done(), ms);
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
  });
}

/**
 * 判断这段回复是不是「跑飞」了 —— 也就是用户看到的「聊久了乱说话」。
 *
 * 根因是采样参数（frequency/presence penalty + 高温度）逼模型避开常用词，
 * 它就开始硬凑生僻搭配：语法还是中文，语义却散了，而且越说越长、几乎不带标点。
 * 这里只做「事后识别」，命中就用保守参数重试一次，别把坏文本发出去。
 */
const SENTENCE_PUNCT = /[，。！？!?；;、…~～\n]/;

function looksDegenerate(text) {
  const s = String(text || '').trim();
  if (s.length < 80) return false;
  const punct = (s.match(new RegExp(SENTENCE_PUNCT, 'g')) || []).length;
  // 正常中文大概每 10~25 个字一个标点；90 字以上一个标点都没有，基本是凑字
  if (s.length >= 90 && punct === 0) return true;
  if (s.length > 140 && punct / s.length < 0.008) return true;
  // 同一段 6 字片段反复出现（复读）
  const seen = new Map();
  for (let i = 0; i + 6 <= s.length; i += 1) {
    const g = s.slice(i, i + 6);
    const n = (seen.get(g) || 0) + 1;
    if (n >= 4) return true;
    seen.set(g, n);
  }
  return false;
}

/** 撞上 max_tokens 被截断时，退到最后一个完整句子，别把半句话发出去 */
function cutToSentence(text) {
  const s = String(text || '').trim();
  if (s.length <= 40) return s;
  const marks = [...s.matchAll(/[。！？!?…~～]/g)];
  const limit = Math.floor(s.length * 0.6);
  const last = marks.filter((m) => m.index >= limit).pop();
  return last ? s.slice(0, last.index + 1) : s;
}

function parseSseLines(bufferText) {
  const events = [];
  const chunks = bufferText.split(/\r?\n\r?\n/);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const dataLines = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    events.push(dataLines.join('\n'));
  }
  return events;
}

class DeepSeekClient {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    // OpenCode Go 要求客户端自报身份 + 一个稳定的会话号（用于路由和 prompt 缓存）。
    // 同一进程内保持不变，等于「这一个对话」的 session。
    this.sessionId = 'whale-girl-' + crypto.randomBytes(12).toString('hex');
    // 最近一次 API 返回的 usage，供 Bot 对比估算误差（只记计数）
    this.lastUsage = null;
    this.reload();
  }

  /** 设置面板保存后调用，立即生效，无需重启 */
  reload() {
    const rt = resolveRuntime(this.config);
    this.runtime = rt;
    this.provider = rt.provider;
    this.providerLabel = rt.providerLabel;
    this.apiKey = rt.apiKey;
    this.model = rt.model;
    this.baseUrl = rt.baseUrl;
    this.temperature = rt.temperature;
    this.mock = rt.mock;
    this.needsKey = rt.needsKey;
    const ds = this.config.deepseek || {};
    this.frequencyPenalty = Number(ds.frequencyPenalty) || 0;
    this.presencePenalty = Number(ds.presencePenalty) || 0;
    this.maxTokens = ds.maxTokens || 700;
    this.timeoutMs = ds.timeoutMs || 45000;
    return this;
  }

  get isMock() {
    // 本地模型（Ollama 等）不需要 Key；需要 Key 的服务没填 Key 就走演示模式
    return this.mock || (this.needsKey && !this.apiKey);
  }

  /** 记下 API 返回的 usage（不打印内容，只记数字） */
  _recordUsage(json) {
    const u = json && json.usage;
    if (!u) return;
    this.lastUsage = {
      promptTokens: Number(u.prompt_tokens) || 0,
      completionTokens: Number(u.completion_tokens) || 0,
      totalTokens: Number(u.total_tokens) || (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0),
      at: Date.now(),
    };
  }

  /**
   * Key 失效时自动切到另一个存过 Key 的服务商（比如智谱免费档），
   * 免得主人正在聊天时，她只会重复「钥匙不对」。
   */
  switchFallback() {
    try {
      const { loadSettings, saveSettings, PROVIDERS } = require('../infra/config');
      const saved = loadSettings(this.config).keys || {};
      const current = String(this.provider || '');
      const order = ['zhipu', 'deepseek', 'qwen', 'siliconflow'];
      for (const name of order) {
        if (name === current) continue;
        const key = saved[name];
        if (!key) continue;
        const preset = PROVIDERS[name];
        if (!preset) continue;
        saveSettings(this.config, { provider: name, baseUrl: preset.baseUrl, model: preset.model, mock: false, apiKey: key });
        this.reload();
        this.logger && this.logger.warn(`[llm] ${current} 的 Key 失效，自动切到备用：${this.providerLabel}`);
        return { from: current, to: this.provider, label: this.providerLabel };
      }
    } catch (err) {
      this.logger && this.logger.warn('[llm] 切换备用服务商失败：' + err.message);
    }
    return null;
  }

  endpoint() {
    const base = String(this.baseUrl || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
  }

  /**
   * 备用路径：本地服务（Ollama / LM Studio / vLLM / llama.cpp）的 OpenAI 兼容接口一般挂在
   * `/v1/chat/completions`。用户照着文档只填 `http://127.0.0.1:11434`（没有 /v1）时，
   * 主路径会打到不存在的 `/chat/completions` 上拿到 404 —— 这里给出另一条路，404 时再试一次。
   * 只在本地 / 内网地址上这么做：云端 404 一般是模型名不对，换路径没有意义。
   */
  altEndpoint() {
    if (!this.runtime || !this.runtime.isLocal) return '';
    const ep = this.endpoint();
    if (/\/v1\/chat\/completions$/.test(ep)) return ep.replace(/\/v1\/chat\/completions$/, '/chat/completions');
    if (/\/chat\/completions$/.test(ep)) return ep.replace(/\/chat\/completions$/, '/v1/chat/completions');
    return '';
  }

  describe() {
    return {
      mock: this.isMock,
      provider: this.provider,
      providerLabel: this.providerLabel,
      needsKey: this.needsKey,
      model: this.model,
      baseUrl: this.baseUrl,
      keyMasked: maskKey(this.apiKey),
      temperature: this.temperature,
    };
  }

  buildPayload({ system, turns = [], stream = false, maxTokens, safe = false }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const t of turns) {
      if (!t || !t.content) continue;
      const role = t.role === 'assistant' ? 'assistant' : t.role === 'system' ? 'system' : 'user';
      messages.push({ role, content: t.content });
    }
    const payload = {
      model: this.model,
      messages,
      stream,
      temperature: (() => {
        // safe = 刚才那条跑飞了，这次用更稳的参数再要一遍
        let t = safe ? Math.min(0.7, Number(this.temperature) || 0.7) : Math.max(0, Math.min(2, Number(this.temperature) || 0.95));
        // 智谱 GLM 的 temperature 只接受 0~1
        if (this.provider === 'zhipu') t = Math.min(t, 0.99);
        return t;
      })(),
      max_tokens: (() => {
        const want = Number(maxTokens) || this.maxTokens;
        // 正常请求：调用方可以要更少，但不会超过配置上限
        if (!safe) return Math.min(want, this.maxTokens);
        // 跑飞重试：给足预算，别再因为 320 token 把话截断
        return Math.min(Math.max(want, 900), 2000);
      })(),
    };
    // 惩罚项会逼模型避开常用词，是「乱说话」的元凶之一；跑飞重试时一律不带
    if (!safe && this.frequencyPenalty) payload.frequency_penalty = this.frequencyPenalty;
    if (!safe && this.presencePenalty) payload.presence_penalty = this.presencePenalty;
    // DeepSeek 流式默认不回 usage；显式要一下，用来校准 token 估算。
    // 其它兼容服务不认这个字段，别硬塞。
    if (stream && this.provider === 'deepseek') payload.stream_options = { include_usage: true };
    return payload;
  }

  /** 真发一次 POST；调用方决定要不要换路径重来 */
  _post(url, { body, headers, signal }) {
    const mod = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'http:' ? 80 : 443),
          path: url.pathname + url.search,
          method: 'POST',
          headers,
        },
        (res) => resolve({ req, res })
      );
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new LlmError(FRIENDLY.timeout, { code: 'timeout', detail: 'request timeout' }));
      });
      req.on('error', (err) => {
        if (err instanceof LlmError) return reject(err);
        const localHint =
          this.runtime && this.runtime.isLocal
            ? '连不上本地模型…Ollama 启动了吗？（命令行运行 ollama serve）'
            : FRIENDLY.network;
        reject(
          new LlmError(localHint, {
            code: 'network',
            retryable: true,
            detail: `${err.code || ''} ${err.message}`.trim(),
          })
        );
      });
      if (signal) {
        const abort = () => req.destroy(new LlmError('aborted', { code: 'aborted' }));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        req.once('close', () => signal.removeEventListener('abort', abort));
      }
      req.end(body);
    });
  }

  async _open(payload, { signal, stream } = {}) {
    if (this.isMock) throw new LlmError(FRIENDLY.nokey, { code: 'nokey' });
    let url;
    try {
      url = new URL(this.endpoint());
    } catch {
      throw new LlmError(FRIENDLY.default, { code: 'bad_url', detail: 'invalid baseUrl: ' + this.baseUrl });
    }
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Accept: stream ? 'text/event-stream' : 'application/json',
    };
    // 本地模型（Ollama / LM Studio 等）通常不需要 Key，别带空的 Authorization
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    // OpenCode Go（opencode.ai）拒收不带会话头的请求：
    //   HTTP 400 "Request is missing x-opencode-session and cannot be routed efficiently"
    // 文档也要求客户端用自家 User-Agent 而不是通用 SDK 名。
    if (/(^|\.)opencode\.ai$/i.test(url.hostname)) {
      headers['x-opencode-session'] = this.sessionId;
      headers['User-Agent'] = 'whale-girl/3.54';
    }
    const first = await this._post(url, { body, headers, signal });
    if (first.res.statusCode !== 404) return first;
    // 404 且是本地服务：多半是 /v1 少了或多了（Ollama 根地址），换另一条路径再试一次
    const alt = this.altEndpoint();
    if (!alt) return first;
    let altUrl;
    try {
      altUrl = new URL(alt);
    } catch {
      return first;
    }
    try { first.res.resume(); } catch { /* ignore */ }
    this.logger && this.logger.debug(`本地服务 404（${url.pathname}），换 ${altUrl.pathname} 再试一次`);
    return this._post(altUrl, { body, headers, signal });
  }

  async _readAll(res, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const finish = (err, value) => {
        if (signal) signal.removeEventListener('abort', abort);
        if (err) reject(err); else resolve(value);
      };
      const abort = () => {
        finish(new LlmError('aborted', { code: 'aborted' }));
        res.destroy();
      };
      res.on('data', (c) => {
        chunks.push(c);
        if (chunks.reduce((n, b) => n + b.length, 0) > 1024 * 1024) {
          finish(new LlmError(FRIENDLY.default, { code: 'too_large', detail: 'response too large' }));
          res.destroy();
        }
      });
      res.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
      res.on('error', (err) =>
        finish(new LlmError(FRIENDLY.network, { code: 'network', detail: 'response error: ' + err.message, retryable: true }))
      );
      res.on('aborted', () => finish(new LlmError(FRIENDLY.network, { code: 'network', retryable: true })));
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
    });
  }

  async _errorFrom(res, opts = {}) {
    let text = '';
    try {
      text = await this._readAll(res, opts);
    } catch {
      /* ignore */
    }
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.message || text;
    } catch {
      /* ignore */
    }
    return new LlmError(friendlyForStatus(res.statusCode, detail), {
      code: 'http_' + res.statusCode,
      status: res.statusCode,
      detail: `HTTP ${res.statusCode}: ${String(detail).slice(0, 300)}`,
      retryable: res.statusCode === 429 || res.statusCode >= 500,
    });
  }

  /** 非流式，返回完整文本 */
  async complete({ system, turns, maxTokens, signal }) {
    this.lastUsage = null;
    let lastErr = null;
    let sawDegenerate = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      // 第一次用用户配的参数；发现跑飞或撞长度上限后，用更稳的参数再要一遍
      const safe = attempt > 0;
      try {
        if (signal && signal.aborted) throw new LlmError('aborted', { code: 'aborted' });
        const payload = this.buildPayload({ system, turns, stream: false, maxTokens, safe });
        const { res } = await this._open(payload, { stream: false, signal });
        if (res.statusCode !== 200) throw await this._errorFrom(res, { signal });
        const raw = await this._readAll(res, { signal });
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          throw new LlmError(FRIENDLY.empty, { code: 'bad_json', detail: 'invalid json: ' + raw.slice(0, 200) });
        }
        this._recordUsage(json);
        const choice = (json && json.choices && json.choices[0]) || {};
        const text = String((choice.message && choice.message.content) || '').trim();
        if (!text) throw new LlmError(FRIENDLY.empty, { code: 'empty' });
        const truncated = choice.finish_reason === 'length';
        const degenerate = looksDegenerate(text);
        if ((degenerate || truncated) && !safe) {
          sawDegenerate = true;
          this.logger &&
            this.logger.warn(
              `回复${degenerate ? '疑似跑飞（凑字/没标点）' : '撞上长度上限'}（${text.length} 字），换保守参数重试一次`
            );
          continue;
        }
        this.logger &&
          this.logger.debug(
            `DeepSeek 完成：${payload.messages.length} 条消息，输出 ${text.length} 字${safe ? '（保守参数）' : ''}`
          );
        return truncated ? cutToSentence(text) : text;
      } catch (err) {
        if (signal && signal.aborted) throw new LlmError('aborted', { code: 'aborted' });
        lastErr = err;
        const llmErr = err instanceof LlmError ? err : new LlmError(FRIENDLY.default, { detail: String(err && err.message) });
        if (!llmErr.retryable || attempt === 2 || llmErr.code === 'aborted') {
          // 接口错误时如果之前已经拿到过跑飞的文本，至少给个能用的短句
          if (sawDegenerate && llmErr.retryable) break;
          throw llmErr;
        }
        await sleep(700, signal);
      }
    }
    if (lastErr) throw lastErr;
    throw new LlmError(FRIENDLY.empty, { code: 'empty' });
  }

  /**
   * 测试当前配置能不能连上、模型能不能回话。给设置面板的「测试连接」用。
   * @returns {Promise<{ok: boolean, provider: string, model: string, ms: number, sample?: string, message?: string}>}
   */
  async probe() {
    const started = Date.now();
    const base = {
      provider: this.provider,
      providerLabel: this.providerLabel,
      model: this.model,
      baseUrl: this.baseUrl,
      ms: 0,
    };
    if (this.isMock) {
      return { ...base, ok: false, ms: Date.now() - started, message: FRIENDLY.nokey };
    }
    try {
      const sample = await this.complete({
        system: '你是连接测试助手。',
        turns: [{ role: 'user', content: '只回复两个字：咕噜' }],
        maxTokens: 32,
      });
      return { ...base, ok: true, ms: Date.now() - started, sample: String(sample).slice(0, 60) };
    } catch (err) {
      const message =
        err instanceof LlmError ? err.userMessage : '呜…连接测试失败：' + (err && err.message ? err.message : String(err));
      // 把原始错误也带出来，方便判断是额度、Key 还是网络
      const detail = (err && (err.detail || err.message)) || '';
      return { ...base, ok: false, ms: Date.now() - started, message, detail: String(detail).slice(0, 300) };
    }
  }

  /**
   * 用当前模型的官方 tokenizer 精确数一次 prompt token（只在人设保存/导入时用，不进热路径）。
   *
   * 不引本地词表：给服务商发一条 max_tokens 很小、temperature=0 的请求，读 usage.prompt_tokens。
   * 为了扣掉 chat 模板固定开销，先用空 system 量一次，再用目标 system 量一次，取差值。
   * 失败返回 null，由调用方退回本地估算。
   */
  async countPromptTokens(systemText, { timeoutMs = 6000 } = {}) {
    if (!this || this.isMock) return null;
    const measure = async (system) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 6000));
      try {
        const payload = this.buildPayload({
          system,
          turns: [{ role: 'user', content: '。' }],
          stream: false,
          maxTokens: 4,
        });
        payload.temperature = 0;
        const { res } = await this._open(payload, { stream: false, signal: controller.signal });
        if (res.statusCode !== 200) throw await this._errorFrom(res, { signal: controller.signal });
        const raw = await this._readAll(res, { signal: controller.signal });
        const json = JSON.parse(raw);
        const n = Number(json && json.usage && json.usage.prompt_tokens);
        return Number.isFinite(n) && n > 0 ? n : null;
      } finally {
        clearTimeout(timer);
      }
    };
    const full = await measure(String(systemText || ''));
    if (full == null) return null;
    let base = 0;
    try {
      base = (await measure('')) || 0;
    } catch {
      base = 0;
    }
    return {
      tokens: Math.max(0, full - base),
      promptTokens: full,
      basePromptTokens: base,
      model: this.model,
      provider: this.provider,
      at: Date.now(),
    };
  }

  /**
   * 流式，异步生成器，每次 yield 一段新增文本。
   */
  async *stream({ system, turns, signal }) {
    this.lastUsage = null;
    const payload = this.buildPayload({ system, turns, stream: true });
    const { req, res } = await this._open(payload, { signal, stream: true });
    if (res.statusCode !== 200) throw await this._errorFrom(res);
    res.setEncoding('utf8');
    let buffer = '';
    let sent = 0;
    try {
      for await (const chunk of res) {
        buffer += chunk;
        const events = parseSseLines(buffer);
        if (!events.length) continue;
        // 保留最后一个不完整片段
        const lastBreak = Math.max(buffer.lastIndexOf('\n\n'), buffer.lastIndexOf('\r\n\r\n'));
        buffer = lastBreak >= 0 ? buffer.slice(lastBreak).replace(/^\r?\n\r?\n/, '') : buffer;
        for (const data of events) {
          if (data === '[DONE]') {
            this.logger && this.logger.debug(`DeepSeek 流式结束：${sent} 字`);
            return;
          }
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          if (json?.error) {
            throw new LlmError(FRIENDLY.default, { code: 'stream_error', detail: String(json.error.message || '') });
          }
          if (json && json.usage) this._recordUsage(json);
          const delta = json?.choices?.[0]?.delta;
          const piece = delta?.content;
          if (piece) {
            sent += piece.length;
            yield piece;
          }
        }
      }
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (signal && signal.aborted) return;
      throw new LlmError(FRIENDLY.network, { code: 'network', detail: 'stream error: ' + (err && err.message) });
    } finally {
      try { req.destroy(); } catch { /* ignore */ }
      try { res.destroy(); } catch { /* ignore */ }
    }
    if (!sent) throw new LlmError(FRIENDLY.empty, { code: 'empty' });
  }
}

module.exports = { DeepSeekClient, LlmError, FRIENDLY, parseSseLines, friendlyForStatus, looksDegenerate, cutToSentence };
