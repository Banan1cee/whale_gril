'use strict';

/**
 * DeepSeek 客户端（兼容 OpenAI 的 /chat/completions 协议）。
 * 只用 Node 内置模块，支持流式与非流式，失败时抛带「鲸鱼娘口吻」提示的 LlmError。
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { resolveRuntime, maskKey } = require('../infra/config');
const { describeError } = require('../infra/errors');

const FRIENDLY = {
  nokey: '呜…人家还没拿到深海的钥匙（API Key），去右上角「设置」里填一下吧 (｡•́︿•̀｡)',
  401: '呜…人家的深海钥匙（API Key）好像不对，去设置里换一把吧 (´･_･`)',
  402: '服务商说余额不足（HTTP 402）。DeepSeek 要先充值才能用；想先用免费额度，可以在「模型服务」里换成智谱 GLM-4.6V-Flash 或千问。',
  403: '这扇门人家推不开（403），可能是 Key 没权限哦',
  429: '这家的额度/频率用完了（HTTP 429）。千问常见是免费额度用完，换 qwen3.8-flash 或 qwen3.7-flash 试试；别的服务商就是额度或限流。',
  404: '这个模型名服务商用不了（HTTP 404）。千问的话换成 qwen3.8-flash / qwen3.7-plus / qwen3.8-max 之一。',
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
    // detail 是给日志/诊断用的结构证据（HTTP 状态、finish、usage…），不发给用户。
    // 以前只放进 message，err.detail 一直是 undefined，extractor / probe 都读不到。
    this.detail = detail || '';
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

/**
 * 取「答案正文」。
 *
 * 有的兼容服务会把 content 发成 [{type:'text',text:'…'}] 的数组（多模态格式），
 * 以前直接 String(...) 会得到 "[object Object]" 当回复发出去。reasoning_content /
 * reasoning / reasoning_details 只做诊断，永远不拼进正文。
 */
function pickText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
      .map((x) => x.text)
      .join('');
  }
  return '';
}

/**
 * 剥掉混进正文的思考片段。只在「成对出现」或「在开头」时剥，避免误伤正常正文：
 * DeepSeek 偶尔把  thinking…<｜end▁of▁thinking｜> 留在 content 里，Kimi / 一些网关还会
 * 用 <thinking>、<reasoning>，或者正文开头一整段 "Thinking: …"。
 */
function stripThinking(text) {
  let s = String(text == null ? '' : text);
  if (!s) return '';
  // 成对标签（DeepSeek 的结束符是全角竖线包着的 <｜end▁of▁thinking｜>）
  s = s.replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|<｜end[^｜]*thinking｜>)/gi, '');
  s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  // 没有尖括号开标签、但正文开头直接是思考内容 + DeepSeek 结束符：从开头整段剥掉
  s = s.replace(/^\s*[\s\S]*?<｜end[^｜]*thinking｜>/i, '');
  // 只剩开始标记、没有结束符：把标记本身删掉（内容见下一条规则）
  s = s.replace(/<｜[^｜]*thinking｜>/gi, '');
  // 只有开标签没闭合：宁可整段丢掉，也不能把思考当答案发出去
  s = s.replace(/<think(?:ing)?>[\s\S]*$/i, '');
  s = s.replace(/<reasoning>[\s\S]*$/i, '');
  // 正文开头的 "Thinking: …"：到空行或文末为止
  s = s.replace(/^\s*Thinking:\s*[\s\S]*?(?:\n\s*\n|$)/i, '');
  return s.trim();
}

/** 服务商上报的思考 token（各家字段名不一样，拿不到就 0） */
function reasoningTokensOf(json) {
  const usage = (json && json.usage) || {};
  const details = usage.completion_tokens_details || usage.output_tokens_details || {};
  const n = Number(details.reasoning_tokens);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 每个模型族「关思考 / 开思考」要发什么参数 —— 2026-11-04 实测 11 个模型得来。
 * 顺序就是降级顺序：先换字段名，再丢参数。canDisable=false 表示关不干净（gpt-5 / O 系），
 * 只能靠加预算顶着。
 */
const RULE = {
  deepseek: { off: [{ thinking: { type: 'disabled' } }], on: [{ reasoning_effort: 'low' }], canDisable: true },
  qwen: { off: [{ enable_thinking: false }, { thinking: { type: 'disabled' } }], on: [{ reasoning_effort: 'low' }], canDisable: true },
  glm: { off: [{ thinking: { type: 'disabled' } }], on: [{ reasoning_effort: 'low' }], canDisable: true },
  // glm-5.3（非 flash）是 thinking-only：发 thinking/eefort:none 会 400，只能降到 low
  glm53: { off: [{ reasoning_effort: 'low' }], on: [{ reasoning_effort: 'low' }], canDisable: true },
  hunyuan: { off: [{ reasoning_effort: 'none' }], on: [{ reasoning_effort: 'low' }], canDisable: true },
  kimi: { off: [{ reasoning_effort: 'none' }], on: [{ reasoning_effort: 'low' }], canDisable: true },
  minimax: { off: [{ enable_thinking: false }], on: [{ enable_thinking: true }], canDisable: true },
  thinkingDisabled: { off: [{ thinking: { type: 'disabled' } }], on: [{ reasoning_effort: 'low' }], canDisable: true },
  noThinking: { off: [], on: [], canDisable: true },
  // ChatGPT / Sub2API 的 gpt-5 与 O 系：只能 minimal，关不干净
  openaiReasoning: { off: [{ reasoning_effort: 'minimal' }], on: [{ reasoning_effort: 'low' }], canDisable: false },
  claude: { off: [{ thinking: { type: 'disabled' } }], on: [{ thinking: { type: 'enabled', budget_tokens: 1024 } }], canDisable: true },
  gemini: { off: [{ reasoning_effort: 'none' }, { thinking_budget: 0 }], on: [{ reasoning_effort: 'low' }], canDisable: true },
};

/** 按模型名（优先）匹配思考能力表；不认识返回 null，交给 provider 兜底 */
function thinkingRuleByModel(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  // 更具体的型号必须排在族前面：glm-5.3-flash 走 thinking:disabled，不能落到 glm-5.3 那条
  if (/^(gpt-5|gpt5|o[134](?:-|$)|chatgpt)/.test(m)) return RULE.openaiReasoning;
  if (/^claude/.test(m)) return RULE.claude;
  if (/(^|[/-])glm-5\.3(?!-flash)/.test(m)) return RULE.glm53;
  if (/(^|[/-])glm/.test(m)) return RULE.glm;
  if (/(^|[/-])deepseek/.test(m)) return RULE.deepseek;
  if (/(^|[/-])qwen/.test(m)) return RULE.qwen;
  if (/(^|[/-])hy\d/.test(m)) return RULE.hunyuan;
  if (/(^|[/-])kimi/.test(m)) return RULE.kimi;
  if (/(^|[/-])minimax/.test(m)) return RULE.minimax;
  if (/(^|[/-])(mimo|longcat)/.test(m)) return RULE.thinkingDisabled;
  if (/(^|[/-])step-/.test(m)) return RULE.noThinking;
  if (/^(gemini|grok)/.test(m)) return RULE.gemini;
  return null;
}

/** provider 兜底：只对「这家只会跑自家模型」的服务商生效，opencode/custom/tju 交给自适应 */
function thinkingRuleByProvider(provider) {
  switch (String(provider || '')) {
    case 'deepseek': return RULE.deepseek;
    case 'zhipu': return RULE.glm;
    case 'qwen': return RULE.qwen;
    default: return null;
  }
}

/**
 * 这个 provider|model 该怎么关 / 开思考。
 * @returns {{off:Array<object>, on:Array<object>, canDisable:boolean}}
 */
function thinkingPlan(provider, model) {
  const rule = thinkingRuleByModel(model) || thinkingRuleByProvider(provider)
    // custom / tju / 未知模型：不发任何思考参数，靠 400 自适应降级
    || RULE.noThinking;
  return { off: rule.off.slice(), on: rule.on.slice(), canDisable: rule.canDisable !== false };
}

/**
 * 空响应到底为什么空：只拼「结构证据」，不碰聊天正文。
 *
 * 以前空响应只抛一句「空泡泡」，detail 是空的 —— 日志里既看不出是限流、
 * 审核、还是 max_tokens 被思考打满，也看不出是不是 200 里塞了个错误体。
 * 现在把 finish_reason / usage / 有没有 reasoning_content / choices 是否为空
 * 一起带进 detail，下次再出现能直接定位。
 */
function describeEmpty(json, choice = {}) {
  const bits = [];
  if (!json || !Array.isArray(json.choices)) bits.push('choices=缺失');
  else if (!json.choices.length) bits.push('choices=空');
  const finish = choice && choice.finish_reason;
  if (finish) bits.push('finish=' + finish);
  const usage = json && json.usage;
  if (usage) bits.push(`usage=${Number(usage.prompt_tokens) || 0}/${Number(usage.completion_tokens) || 0}`);
  // 思考 token 计入 max_tokens：不记这一项，就分不清「模型没说话」和「预算全用来想了」
  bits.push('reasoning_tokens=' + reasoningTokensOf(json));
  const msg = (choice && choice.message) || {};
  if (msg.reasoning_content) bits.push('reasoning=' + String(msg.reasoning_content).length + '字');
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) bits.push('tool_calls=' + msg.tool_calls.length);
  if (msg.refusal) bits.push('refusal=' + String(msg.refusal).slice(0, 40));
  if (!bits.length) bits.push('未知');
  return '空响应（' + bits.join(' ') + '）';
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
    // 最近若干次调用的 usage（只存数字）。一轮回复可能调多次模型（复读重写 / 降级重试），
    // Bot 靠 seq 水位把这些调用累加起来算「本轮用量」，不用在每个调用点手工记账。
    this.usageSeq = 0;
    this.usageEvents = [];
    // 思考能力缓存（data/thinking-caps.json）：记录「这个模型实测关不干净、天花板多少」，
    // 每次 reload 清空，靠 provider|model + baseUrl 校验失效
    this._caps = null;
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
    // 聊天默认关思考（快）；开了先想一遍再答。后台抽取显式传 thinking:false。
    this.thinking = rt.thinking === true;
    this.chatThinkingTokens = Number(ds.chatThinkingTokens) || 2000;
    this.thinkingMaxTokens = Number(ds.thinkingMaxTokens) || 5000;
    this._caps = null;
    return this;
  }

  /** 思考能力缓存文件：优先 dataDir，测试里退回 settingsFile 所在目录，别往仓库 data/ 里写 */
  capsFile() {
    const p = (this.config && this.config.paths) || {};
    const dir = p.dataDir || (p.settingsFile ? path.dirname(p.settingsFile) : path.join(os.tmpdir(), 'whale-girl'));
    return path.join(dir, 'thinking-caps.json');
  }

  _loadCaps() {
    if (this._caps) return this._caps;
    this._caps = {};
    try {
      const obj = JSON.parse(fs.readFileSync(this.capsFile(), 'utf8'));
      if (obj && typeof obj === 'object') this._caps = obj;
    } catch { /* 没有缓存就从零开始 */ }
    return this._caps;
  }

  /** 取本模型生效的自适应档位；模型名或 baseUrl 变了就失效 */
  _capsFor() {
    const all = this._loadCaps();
    const entry = all[`${this.provider}|${this.model}`];
    if (!entry) return null;
    if (entry.model && entry.model !== this.model) return null;
    if (entry.baseUrl && this.baseUrl && entry.baseUrl !== this.baseUrl) return null;
    return entry;
  }

  _saveCaps(patch) {
    const all = this._loadCaps();
    const key = `${this.provider}|${this.model}`;
    all[key] = {
      ...(all[key] || {}),
      ...patch,
      provider: this.provider,
      model: this.model,
      baseUrl: this.baseUrl,
      at: Date.now(),
    };
    try {
      const file = this.capsFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    } catch (err) {
      this.logger && this.logger.warn('[llm] 写思考能力缓存失败：' + describeError(err));
    }
    return all[key];
  }

  /** 这个 provider|model 该怎么关 / 开思考 */
  thinkingPlan() {
    return thinkingPlan(this.provider, this.model);
  }

  /**
   * 候选参数列表：自适应缓存里已生效的档位优先，再按能力表逐级降级，最后「什么都不发」。
   * 400/422 被拒时按这个顺序换下一个。
   */
  _thinkingCandidates(plan, modeOn) {
    const caps = this._capsFor();
    const saved = caps && (modeOn ? caps.on : caps.off);
    const list = [];
    const push = (item) => {
      if (!item || typeof item !== 'object') return;
      if (!list.some((x) => JSON.stringify(x) === JSON.stringify(item))) list.push(item);
    };
    if (saved && typeof saved === 'object') {
      // 已经学过这个模型认什么写法（包括「什么都不能发」的 {}）：直接用它，别再每轮先 400 一次
      push(saved);
      push({});
      return list;
    }
    if (modeOn || plan.canDisable !== false) {
      for (const item of (modeOn ? plan.on : plan.off) || []) push(item);
    }
    push({});
    return list;
  }

  /** 输出预算：max_tokens 是天花板不是花费，但思考 token 也计入，所以按模式给不同档 */
  _budgetFor({ maxTokens, safe = false, allowOverflow = false, modeOn = false, plan, caps }) {
    const ceiling = Math.max(
      Number(this.maxTokens) || 700,
      Math.min(8000, Number(caps && caps.maxTokens) || 0)
    );
    // 调用方没指定就用「本模型当前天花板」：截断过的话它已经比配置值高
    const want = Number(maxTokens) || ceiling;
    // 跑飞重试：给足预算，别再因为 320 token 把话截断（旧行为）
    if (safe) return Math.min(Math.max(want, 900), 2000);
    // gpt-5 / O 系关不干净：无视开关，按 thinkingMaxTokens 给
    if (plan && plan.canDisable === false) return Number(this.thinkingMaxTokens) || 5000;
    // 后台任务（episode 抽取）：不走聊天那套 700 夹取，但也不能无限给
    if (allowOverflow) return Math.min(Math.max(0, want), 6000);
    // 关不干净的老实模型（实测关思考后 reasoning_tokens 仍 > 0）：后续直接按思考给预算
    if (modeOn || (caps && caps.offThinks)) {
      return Math.min(Math.max(want, Number(this.chatThinkingTokens) || 2000), 6000);
    }
    return Math.min(want, Math.max(700, ceiling));
  }

  /** 自校准：思考吃掉 >70% 预算、或空响应撞长度上限 → 天花板 ×1.5（封顶 8000） */
  _bumpCeiling(reason) {
    const base = Number(this.maxTokens) || 700;
    const caps = this._capsFor() || {};
    const current = Math.max(base, Number(caps.maxTokens) || 0);
    const next = Math.min(8000, Math.round(current * 1.5));
    if (next <= current) return;
    this._saveCaps({ maxTokens: next, bumpReason: reason, bumpedAt: Date.now() });
    this.logger && this.logger.warn(`[llm] ${this.provider}|${this.model} ${reason}，输出上限 ${current} → ${next}`);
  }

  /** 请求成功后：把「降级生效的档位 / 关不干净」写进缓存，并校准天花板 */
  _noteThinking({ plan, modeOn, thinkingParam, reasoningTokens, maxTokens }) {
    const used = thinkingParam && typeof thinkingParam === 'object' ? thinkingParam : {};
    const first = (modeOn ? plan.on : plan.off)[0] || {};
    if (JSON.stringify(used) !== JSON.stringify(first)) {
      // 走到能力表第二档、或「丢参数」才成功 → 记住这个模型认哪套写法
      // （{} 也要记：下次别再把被拒的参数发一遍）
      this._saveCaps(modeOn ? { on: used } : { off: used });
    }
    if (!modeOn && reasoningTokens > 0) {
      // 关了还在想：记下来，后续直接按思考给预算
      this._saveCaps({ offThinks: true, offReasoningTokens: reasoningTokens });
    }
    if (maxTokens > 0 && reasoningTokens / maxTokens > 0.7) {
      this._bumpCeiling(`思考占用 ${Math.round((reasoningTokens / maxTokens) * 100)}%`);
    }
  }

  get isMock() {
    // 本地模型（Ollama 等）不需要 Key；需要 Key 的服务没填 Key 就走演示模式
    return this.mock || (this.needsKey && !this.apiKey);
  }

  /** 记下 API 返回的 usage（不打印内容，只记数字） */
  _recordUsage(json) {
    const u = json && json.usage;
    if (!u) return;
    const promptTokens = Number(u.prompt_tokens) || 0;
    // 缓存命中字段各家不一样：
    //   DeepSeek 原生 → prompt_cache_hit_tokens
    //   OpenAI 兼容 / OpenCode Go → prompt_tokens_details.cached_tokens
    //   OpenCode Go 账单 → opencode.tokens.cache_read
    // 以前只读第一种，用 OpenCode 时界面/日志一直显示「命中 0」，其实前缀缓存是命中的。
    const opencodeTokens = u.opencode && u.opencode.tokens;
    const details = u.prompt_tokens_details || {};
    const rawHit = Number(opencodeTokens && opencodeTokens.cache_read)
      || Number(details.cached_tokens)
      || Number(u.prompt_cache_hit_tokens)
      || 0;
    const hit = Math.min(promptTokens, Math.max(0, Number.isFinite(rawHit) ? rawHit : 0));
    const miss = Number(u.prompt_cache_miss_tokens) || Math.max(0, promptTokens - hit);
    this.lastUsage = {
      promptTokens,
      promptCacheHitTokens: hit,
      promptCacheMissTokens: miss,
      completionTokens: Number(u.completion_tokens) || 0,
      totalTokens: Number(u.total_tokens) || promptTokens + (Number(u.completion_tokens) || 0),
      // 思考 token 计入 completion：单独记一份，日志里才看得出「是不是全用来想了」
      reasoningTokens: reasoningTokensOf(json),
      at: Date.now(),
    };
    this.usageSeq += 1;
    this.usageEvents.push({ seq: this.usageSeq, ...this.lastUsage });
    // 只留最近 64 次：够一轮里的重试，也不会把内存越攒越大
    if (this.usageEvents.length > 64) this.usageEvents.splice(0, this.usageEvents.length - 64);
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
      this.logger && this.logger.warn('[llm] 切换备用服务商失败：' + describeError(err));
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

  /**
   * 拼请求体。
   *
   * 思考参数按「模型族能力表」发：同一句「关掉思考」在 11 个模型上写法全不一样，
   * 发错了不是 400 就是继续想。预算也随模式变：关思考只给 700，开思考至少 2000。
   *
   * @param {{thinking?:boolean, allowOverflow?:boolean, thinkingParam?:object, bigBudget?:boolean}} opts
   *   thinking：显式指定开/关；不传跟设置走
   *   allowOverflow：后台任务（episode 抽取）用，不吃聊天的 700 夹取
   *   thinkingParam：complete() 自适应降级时指定的那一档参数；不传就用能力表第一档
   *   bigBudget：关不掉思考的模型，空响应后加大预算重试
   */
  buildPayload({
    system, turns = [], stream = false, maxTokens, safe = false,
    thinking, allowOverflow = false, thinkingParam, bigBudget = false,
  }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const t of turns) {
      if (!t || !t.content) continue;
      const role = t.role === 'assistant' ? 'assistant' : t.role === 'system' ? 'system' : 'user';
      messages.push({ role, content: t.content });
    }
    const plan = this.thinkingPlan();
    const caps = this._capsFor();
    // 用户的选择；关不干净的模型（gpt-5 / O 系）由预算那一步单独处理，参数照样可以省
    const modeOn = thinking === undefined ? this.thinking === true : thinking === true;
    const params = thinkingParam !== undefined
      ? thinkingParam
      : ((caps && (modeOn ? caps.on : caps.off)) || (modeOn ? plan.on : plan.off)[0] || {});
    let budget = this._budgetFor({ maxTokens, safe, allowOverflow, modeOn, plan, caps });
    if (bigBudget && plan.canDisable === false) {
      // 关不掉思考：加大预算再试一次（封顶 8000，别无限烧）
      budget = Math.min(8000, Math.max(Number(this.thinkingMaxTokens) || 5000, budget) * 2);
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
      max_tokens: budget,
    };
    // OpenAI 系（gpt-5 / o1|o3|o4）字段名不同，而且不认 temperature
    const openaiReasoning = /^(gpt-5|gpt5|o[134](?:-|$)|chatgpt)/.test(String(this.model || '').toLowerCase());
    if (openaiReasoning) {
      delete payload.max_tokens;
      delete payload.temperature;
      payload.max_completion_tokens = budget;
    }
    // 惩罚项会逼模型避开常用词，是「乱说话」的元凶之一；跑飞重试时一律不带
    if (!safe && !openaiReasoning && this.frequencyPenalty) payload.frequency_penalty = this.frequencyPenalty;
    if (!safe && !openaiReasoning && this.presencePenalty) payload.presence_penalty = this.presencePenalty;
    // 思考参数：极少数兼容服务不认任何写法，此时 params 是空对象，什么都不发
    if (params && typeof params === 'object') Object.assign(payload, params);
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

  /**
   * 非流式，返回完整文本。
   *
   * 空响应阶梯（2026-11 修「思考吃满预算 → 空响应」）：
   *   1) 按设置 / 能力表发；
   *   2) 空 && finish=length && reasoning_tokens>0 → 用本族关思考参数 + 原预算重试一次；
   *   3) 关不掉（gpt-5 / O 系）→ 加大预算重试一次；
   *   4) 其它空响应 → 保守参数重试一次；
   *   5) 仍空 → 抛 LlmError(empty, detail)，detail 带 finish/usage/reasoning_tokens。
   * 参数被 400/422 拒时（不同服务商字段名不一样），按候选表换下一档再试。
   */
  async complete({ system, turns, maxTokens, signal, thinking, allowOverflow = false } = {}) {
    this.lastUsage = null;
    let lastErr = null;
    let sawDegenerate = false;
    const plan = this.thinkingPlan();
    // 关不干净的模型（gpt-5 / O 系）：参数用 low、预算用 thinkingMaxTokens，但不能假装「已关」
    let modeOn = thinking === undefined ? this.thinking === true : thinking === true;
    let candidates = this._thinkingCandidates(plan, modeOn);
    let candIdx = 0;
    let safeRetry = false;
    let thinkingFallback = false;
    let bigBudget = false;
    // 阶梯②要「关思考参数 + 原预算」，所以要记住上一次实际发的预算（天花板可能刚被校准抬高）
    let forcedBudget = 0;
    let attempt = 0;
    let degradations = 0;
    const resetCandidates = () => {
      candidates = this._thinkingCandidates(plan, modeOn);
      candIdx = 0;
    };
    while (attempt < 4) {
      attempt += 1;
      // 第一次用用户配的参数；发现跑飞或撞长度上限后，用更稳的参数再要一遍
      const safe = safeRetry;
      const thinkingParam = candidates[Math.min(candIdx, candidates.length - 1)];
      try {
        if (signal && signal.aborted) throw new LlmError('aborted', { code: 'aborted' });
        const payload = this.buildPayload({
          system, turns, stream: false, maxTokens: forcedBudget || maxTokens, safe,
          thinking: modeOn,
          // 已经切到关思考档后，别再让 allowOverflow 把预算拉高——阶梯②要的是「原预算」
          allowOverflow: allowOverflow && !thinkingFallback,
          thinkingParam,
          bigBudget,
        });
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
        // HTTP 200 也可能带错误体（网关 / 反向代理 / 部分兼容服务会这么干）。
        // 以前这里直接当「模型没说话」吞成空响应，日志里只剩一句「空泡泡」，
        // 真正的限流原因全丢了。
        if (json && json.error) {
          const errObj = json.error;
          const detail = String((errObj && (errObj.message || errObj.msg)) || errObj || '').slice(0, 300);
          const status = Number(errObj && (errObj.code || errObj.status)) || 0;
          throw new LlmError(friendlyForStatus(status, detail), {
            code: 'api_error',
            status,
            detail: 'HTTP 200 但带错误体：' + (detail || '(没有说明)'),
            retryable: true,
          });
        }
        const choice = (json && json.choices && json.choices[0]) || {};
        const reasoningTokens = reasoningTokensOf(json);
        // 思考内容永不拼进正文：reasoning_content / reasoning / reasoning_details 只用于诊断
        const text = stripThinking(pickText(choice.message)).trim();
        if (!text) {
          const emptyDetail = describeEmpty(json, choice);
          // ② 思考吃满：关掉思考 + 原预算再要一次。这是 episode 抽取空响应的根因。
          if (choice.finish_reason === 'length' && reasoningTokens > 0 && plan.canDisable !== false && !thinkingFallback) {
            thinkingFallback = true;
            modeOn = false;
            forcedBudget = Number(payload.max_tokens || payload.max_completion_tokens) || 0;
            resetCandidates();
            this._bumpCeiling('空响应且思考吃满');
            this.logger && this.logger.warn(`模型返回${emptyDetail}，思考吃满预算，切到关思考档重试一次`);
            continue;
          }
          // ③ 关不掉（gpt-5 / O 系）：加大预算重试一次
          if (plan.canDisable === false && !bigBudget) {
            bigBudget = true;
            this._bumpCeiling('空响应且思考关不掉');
            this.logger && this.logger.warn(`模型返回${emptyDetail}，思考关不掉，加大预算重试一次`);
            continue;
          }
          // ④ 其它空响应：换保守参数再要一次
          if (!safeRetry) {
            safeRetry = true;
            this.logger && this.logger.warn(`模型返回${emptyDetail}，换保守参数重试一次`);
            continue;
          }
          // ⑤ 仍空：把结构证据交给调用方（日志里要能看出 finish/usage/reasoning_tokens）
          throw new LlmError(FRIENDLY.empty, { code: 'empty', detail: emptyDetail, retryable: true });
        }
        const truncated = choice.finish_reason === 'length';
        const degenerate = looksDegenerate(text);
        if ((degenerate || truncated) && !safe) {
          sawDegenerate = true;
          this.logger &&
            this.logger.warn(
              `回复${degenerate ? '疑似跑飞（凑字/没标点）' : '撞上长度上限'}（${text.length} 字），换保守参数重试一次`
            );
          safeRetry = true;
          continue;
        }
        // 走到这里才算成功：记录生效档位 / 校准天花板
        this._noteThinking({
          plan,
          modeOn,
          thinkingParam,
          reasoningTokens,
          maxTokens: Number(payload.max_tokens || payload.max_completion_tokens) || 0,
        });
        this.logger &&
          this.logger.debug(
            `DeepSeek 完成：${payload.messages.length} 条消息，输出 ${text.length} 字${safe ? '（保守参数）' : ''}`
          );
        return truncated ? cutToSentence(text) : text;
      } catch (err) {
        if (signal && signal.aborted) throw new LlmError('aborted', { code: 'aborted' });
        lastErr = err;
        const llmErr = err instanceof LlmError ? err : new LlmError(FRIENDLY.default, { detail: String(err && err.message) });
        // 参数被拒（400/422 且提示里带 max_tokens / thinking / temperature…）：
        // 换下一档候选（先换字段名，再丢参数），这不算一次「重试」，但要有上限
        if (
          (llmErr.status === 400 || llmErr.status === 422)
          && /max_tokens|max_completion_tokens|unsupported_parameter|unsupported_value|temperature|thinking|reasoning_effort|enable_thinking|budget_tokens/i.test(String(llmErr.detail || ''))
          && candIdx + 1 < candidates.length
          && degradations < 8
        ) {
          candIdx += 1;
          degradations += 1;
          attempt -= 1;
          this.logger &&
            this.logger.warn(`思考参数被拒（${describeError(llmErr, { maxDetail: 120 })}），换下一档参数重试`);
          continue;
        }
        // 空响应阶梯已经在上面走完，这里不再额外重试（否则一条消息要等四轮）
        if (llmErr.code === 'empty' || !llmErr.retryable || attempt >= 3 || llmErr.code === 'aborted') {
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
        // OpenAI 推理模型没有 temperature 字段，别为了数 token 又塞回去
        if ('temperature' in payload) payload.temperature = 0;
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
    // 一个字都没吐时也要留下证据：finish_reason 能区分「预算打满」和「模型真的没说话」
    let lastFinish = '';
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
            // 有内容就正常收尾；一个字都没吐时不能在这里 return（否则跳过后面的空响应诊断）
            if (sent) {
              this.logger && this.logger.debug(`DeepSeek 流式结束：${sent} 字`);
              return;
            }
            break;
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
          const finish = json?.choices?.[0]?.finish_reason;
          if (finish) lastFinish = finish;
          const delta = json?.choices?.[0]?.delta;
          // 思考内容（delta.reasoning_content 等）只诊断、整段丢弃，绝不拼进正文
          const piece = pickText(delta);
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
    if (!sent) {
      throw new LlmError(FRIENDLY.empty, {
        code: 'empty',
        detail: '空响应（流式没吐字' + (lastFinish ? ' finish=' + lastFinish : '') + '）',
      });
    }
  }
}

module.exports = {
  DeepSeekClient,
  LlmError,
  FRIENDLY,
  parseSseLines,
  friendlyForStatus,
  looksDegenerate,
  cutToSentence,
  thinkingPlan,
  pickText,
  stripThinking,
  reasoningTokensOf,
};

