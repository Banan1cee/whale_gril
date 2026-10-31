'use strict';

const { loadSettings, saveSettings, resolveRuntime, maskKey, PROVIDERS, isLocalUrl, normalizeBaseUrl } = require('../infra/config');
const { applyConfigPatch } = require('../infra/configPatch');
const vision = require('../adapters/vision');
const { statusPayload } = require('./status');

function getSettings(runtime) {
  const { config, llm } = runtime;
  const rt = resolveRuntime(config);
  const saved = loadSettings(config);
  const providers = {};
  for (const [key, p] of Object.entries(PROVIDERS)) {
    providers[key] = {
      label: p.label,
      baseUrl: p.baseUrl,
      model: p.model,
      needsKey: p.needsKey,
      hint: p.hint,
      models: p.models || [],
    };
  }
  return {
    ok: true,
    mock: llm.isMock,
    provider: llm.provider,
    providerLabel: llm.providerLabel,
    needsKey: llm.needsKey,
    model: llm.model,
    baseUrl: llm.baseUrl,
    temperature: llm.temperature,
    keyMasked: maskKey(rt.apiKey),
    hasKey: Boolean(rt.apiKey),
    userName: String(saved.userName || config.persona.ownerName || ''),
    // 看图（视觉）状态：网页设置里要能看出「填没填、填的是哪把」
    vision: vision.status(config),
    providers,
    group: {
      requireAt: config.group.requireAt,
      freeChat: config.group.freeChat,
      freeChatChance: config.group.freeChatChance,
      cooldownSec: config.group.cooldownSec,
    },
    configFile: config.paths.configFile,
    dataDir: config.paths.dataDir,
  };
}

async function applySettings(runtime, body) {
  const { config, llm } = runtime;
  const patch = {};
  const current = resolveRuntime(config);

  // 切换模型服务：没显式给地址/模型时，用该服务的预设值
  if (typeof body.provider === 'string' && body.provider.trim()) {
    const provider = body.provider.trim();
    if (!PROVIDERS[provider]) throw new Error('不认识的模型服务：' + provider);
    if (provider !== current.provider) {
      patch.provider = provider;
      const preset = PROVIDERS[provider];
      if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) patch.baseUrl = preset.baseUrl;
      if (typeof body.model !== 'string' || !body.model.trim()) patch.model = preset.model;
    }
  }

  if (typeof body.baseUrl === 'string') {
    // 少写协议（`127.0.0.1:11434/v1`）很常见：本机 / 内网地址自动补 http://
    const baseUrl = normalizeBaseUrl(body.baseUrl).slice(0, 300);
    if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) {
      throw new Error('接口地址要以 http:// 或 https:// 开头（本机/内网地址可以直接写 127.0.0.1:11434/v1，会自动补 http://）');
    }
    patch.baseUrl = baseUrl;
  }
  if (typeof body.apiKey === 'string') {
    const key = body.apiKey.trim();
    if (key && (/\s/.test(key) || key.length < 8 || key.length > 300)) {
      throw new Error('API Key 看起来不太对：不能有空格，长度 8~300');
    }
    patch.apiKey = key;
    if (key) patch.mock = false;
  }
  if (typeof body.model === 'string' && body.model.trim()) {
    const model = body.model.trim().slice(0, 80);
    if (!/^[a-zA-Z0-9._\-\/:]{1,80}$/.test(model)) throw new Error('模型名只能包含字母、数字和 . _ - / :');
    patch.model = model;
  }
  // 看图（视觉模型）的 Key：单独一把，存在 data/settings.json 的 visionApiKey，
  // 留空表示「不改」；以前网页没有这个字段，填了也没地方存，于是永远提示未配置
  if (typeof body.visionApiKey === 'string') {
    const vk = body.visionApiKey.trim();
    if (vk && (/\s/.test(vk) || vk.length < 8 || vk.length > 300)) {
      throw new Error('看图 API Key 看起来不太对：不能有空格，长度 8~300');
    }
    if (vk) patch.visionApiKey = vk;
  }
  if (typeof body.mock === 'boolean') patch.mock = body.mock;
  // 「怎么称呼你」：以前只存在浏览器 localStorage 里，换设备就丢；现在写进 data/settings.json
  if (typeof body.userName === 'string') patch.userName = body.userName.trim().slice(0, 24);
  // 只要这次填了 Key，就默认关闭演示模式（防止「有 Key 还在说内置台词」）
  if (patch.apiKey) patch.mock = false;
  // 目标服务本来就不需要 Key（本地 Ollama / 本机 / 内网自建）时，演示模式一律关掉。
  // 网页每次都会把开关一起提交，新装用户默认就勾着 —— 以前这里被 body.mock 覆盖回 true，
  // 于是「选好本地模型、保存、测试连接」全程一次请求都没发到本地服务。
  {
    const nextProvider = patch.provider || current.provider;
    const nextBaseUrl = typeof patch.baseUrl === 'string' ? patch.baseUrl : current.baseUrl;
    const nextPreset = PROVIDERS[nextProvider] || PROVIDERS.custom;
    const keyFree = nextProvider === 'ollama' || !nextPreset.needsKey || isLocalUrl(nextBaseUrl);
    if (keyFree && /^https?:\/\//i.test(nextBaseUrl)) {
      if (patch.mock !== false) runtime.logger.info('目标服务不需要 Key（本地/内网），已自动关掉演示模式');
      patch.mock = false;
    }
  }
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    patch.temperature = Math.max(0, Math.min(2, body.temperature));
  }
  if (body.group && typeof body.group === 'object') {
    // 以前只改内存里的 config.group，没落盘 —— 重启就变回旧值（用户看到「设置无效」）。
    // 统一走 config.json，和启动器设置页写的是同一份数据。
    const groupPatch = {};
    if (typeof body.group.requireAt === 'boolean') groupPatch['group.requireAt'] = body.group.requireAt;
    if (typeof body.group.freeChat === 'boolean') groupPatch['group.freeChat'] = body.group.freeChat;
    if (Number.isFinite(body.group.freeChatChance)) {
      groupPatch['group.freeChatChance'] = Math.max(0, Math.min(1, Number(body.group.freeChatChance)));
    }
    // GET /api/settings 会把 cooldownSec 一起返回；写入侧漏了它的话，调用方
    // 「保存成功但值不变」，和当年「改了没反应」是同一类坑。
    if (Number.isFinite(Number(body.group.cooldownSec))) {
      groupPatch['group.cooldownSec'] = Math.max(0, Math.min(3600, Math.round(Number(body.group.cooldownSec))));
    }
    if (Object.keys(groupPatch).length) {
      try {
        applyConfigPatch(runtime, groupPatch);
      } catch (err) {
        runtime.logger.warn('群聊规则写入 config.json 失败，仅本次生效：' + err.message);
        for (const [dotted, value] of Object.entries(groupPatch)) {
          const key = dotted.slice('group.'.length);
          config.group[key] = value;
        }
      }
    }
  }
  saveSettings(config, patch);
  // 称呼：网页设置和调试台改的是同一份数据，写进 config.json，重启也不会被旧值盖回来
  if (typeof body.userName === 'string') {
    // 清空 = 恢复默认称呼，不是「不改」（以前清空后依然叫旧称呼）
    const name = String(patch.userName || '').trim() || '主人';
    config.persona.ownerName = name;
    try {
      applyConfigPatch(runtime, { 'persona.ownerName': name });
      runtime.logger.info(`称呼已改为「${name}」`);
    } catch (err) {
      runtime.logger.warn('称呼写入 config.json 失败，仅本次生效：' + err.message);
    }
  }
  llm.reload();
  const mode = llm.isMock ? '演示' : `${llm.providerLabel} · ${llm.model}`;
  runtime.logger.info(`设置已更新：${mode}`);
  return {
    ok: true,
    status: statusPayload(runtime),
    settings: {
      mock: llm.isMock,
      provider: llm.provider,
      providerLabel: llm.providerLabel,
      needsKey: llm.needsKey,
      model: llm.model,
      baseUrl: llm.baseUrl,
      keyMasked: maskKey(resolveRuntime(config).apiKey),
      userName: String(loadSettings(config).userName || ''),
      // 保存后前端立刻能把「看图 Key 已存」显示出来
      vision: vision.status(config),
    },
  };
}

module.exports = { getSettings, applySettings };
