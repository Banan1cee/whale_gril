'use strict';

const { loadSettings, saveSettings, resolveRuntime, resolveVisionConfig, maskKey, PROVIDERS, isLocalUrl, normalizeBaseUrl } = require('../infra/config');
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
      // 能收图片的聊天模型：启动器据此决定「看图模型」要不要跟随 chat 模型
      visionModels: p.visionModels || [],
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
    // 深度思考开关 + 两档预算：设置接口里要能回显，日志里要能对上实际发的 max_tokens
    thinking: llm.thinking === true,
    chatThinkingTokens: Number(llm.chatThinkingTokens) || 2000,
    thinkingMaxTokens: Number(llm.thinkingMaxTokens) || 5000,
    keyMasked: maskKey(rt.apiKey),
    hasKey: Boolean(rt.apiKey),
    userName: String(saved.userName || config.persona.ownerName || ''),
    // 看图（视觉）状态：设置接口里要能看出「填没填、填的是哪把」
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

/**
 * 看图模型该不该跟着聊天模型走。
 *
 * - 用户显式传了 visionModel：空串 = 回到「自动」，非空 = 手动钉死；
 * - 没传，且新聊天模型自己能看图，且用户没手动钉过：跟随它；
 * - 没传，且从「能看图的聊天模型」切走了：解除跟随，回落默认看图模型。
 * 返回要合并进 settings.json 的字段；没有变化返回 null。
 */
function decideVisionPatch({ preset, nextModel, saved = {}, manualValue = null, manualProvider = null, manualBaseUrl = null } = {}) {
  const capable = ((preset && preset.visionModels) || []).includes(nextModel);
  // 看图服务商下拉：'' = 自动跟随（和聊天模型同一家），其它 = 显式钉一家。
  const providerPick = typeof manualProvider === 'string' ? manualProvider.trim() : null;
  const pickAuto = providerPick === '';
  // 空串表示「自动」：先解除手动钉住，再交给下面的跟随规则
  const wantsAuto = pickAuto || (typeof manualValue === 'string' && manualValue.trim() === '');
  // 自定义看图接口（visionProvider=custom）：地址和模型都自己填。
  // 以前只能从预设服务商里挑，base_url 就焊死在预设上——中转站、自建视觉服务、
  // 同服务商换路径都没法用；现在把地址也当成一项配置存下来。
  if (providerPick === 'custom') {
    const vm = String(manualValue || '').trim() || String(nextModel || '').trim();
    if (!vm) throw new Error('自定义看图接口要填模型名（例如 glm-4.6v-flash / qwen2.5vl:7b）');
    if (!/^[a-zA-Z0-9._\-\/:]{1,80}$/.test(vm)) {
      throw new Error('看图模型名只能包含字母、数字和 . _ - / :');
    }
    // 只改模型/地址时可能只带进来一半：缺的那个沿用已经存过的，别把配置清空
    const rawBase = manualBaseUrl == null ? String(saved.visionBaseUrl || '') : String(manualBaseUrl);
    const base = normalizeBaseUrl(rawBase).slice(0, 300);
    if (!base) {
      throw new Error('自定义看图接口要填接口地址（例如 https://api.example.com/v1）');
    }
    if (!/^https?:\/\/[^\s]+$/.test(base)) {
      throw new Error('接口地址要以 http:// 或 https:// 开头（本机/内网地址可以直接写 127.0.0.1:8000/v1，会自动补 http://）');
    }
    return {
      visionModel: vm,
      visionManual: true,
      visionAuto: false,
      visionProvider: 'custom',
      visionBaseUrl: base,
    };
  }
  if (providerPick && providerPick !== 'auto') {
    const target = PROVIDERS[providerPick];
    if (!target) throw new Error('不认识的看图服务商：' + providerPick);
    let vm = typeof manualValue === 'string' ? manualValue.trim() : '';
    if (!vm) vm = ((target.visionModels || [])[0] || '').trim();
    if (!vm) throw new Error('「' + target.label + '」没有预设看图模型，换一家或改回「自动跟随」');
    if (!/^[a-zA-Z0-9._\-\/:]{1,80}$/.test(vm)) {
      throw new Error('看图模型名只能包含字母、数字和 . _ - / :');
    }
    return {
      visionModel: vm,
      visionManual: true,
      visionAuto: false,
      visionBaseUrl: target.baseUrl || '',
      visionProvider: providerPick,
    };
  }
  if (typeof manualValue === 'string' && manualValue.trim()) {
    const vm = manualValue.trim().slice(0, 80);
    if (!/^[a-zA-Z0-9._\-\/:]{1,80}$/.test(vm)) {
      throw new Error('看图模型名只能包含字母、数字和 . _ - / :');
    }
    // 手动钉死的模型可能属于别家（比如跟随 DeepSeek 之后改回 glm-4.6v-flash）：
    // 能认出是哪家的就把接口地址一起换过去，认不出就清空、让 config.json 的 vision.baseUrl 生效。
    const owner = Object.entries(PROVIDERS).find(([, p]) => (p.visionModels || []).includes(vm));
    return {
      visionModel: vm,
      visionManual: true,
      visionAuto: false,
      visionBaseUrl: owner && owner[1].baseUrl ? owner[1].baseUrl : '',
      visionProvider: owner ? owner[0] : '',
    };
  }
  const manual = wantsAuto ? false : saved.visionManual === true;
  if (capable && !manual && !providerPick) {
    if (!wantsAuto && saved.visionModel === nextModel) return null;
    return {
      visionModel: nextModel,
      visionManual: false,
      visionAuto: true,
      visionProvider: '',
      ...(preset && preset.baseUrl ? { visionBaseUrl: preset.baseUrl } : {}),
    };
  }
  // 聊天模型不能看图（或用户选回「自动」）：改成这家服务商自己的看图模型。
  // 以前这里清空、直接回落 config 里的智谱默认模型——只有 DeepSeek Key 的用户会当场 401。
  if (!manual) {
    const fallback = ((preset && preset.visionModels) || [])[0] || '';
    if (fallback) {
      if (!wantsAuto && saved.visionModel === fallback && saved.visionAuto === true && !saved.visionProvider) return null;
      return {
        visionModel: fallback,
        visionManual: false,
        visionAuto: true,
        visionProvider: '',
        ...(preset && preset.baseUrl ? { visionBaseUrl: preset.baseUrl } : {}),
      };
    }
    if (saved.visionModel) {
      return { visionModel: '', visionManual: false, visionAuto: false, visionProvider: '', visionBaseUrl: '' };
    }
    return null;
  }
  return null;
}

/**
 * 「从聊天配置复制」：把聊天正在用的接口地址 + 能看图的模型抄到看图设置里。
 * 不动 Key：地址和聊天完全相同时，resolveKey 会直接复用聊天那把（见 adapters/vision.js），
 * 这样不用把同一把密钥在 settings.json 里存两遍。
 */
function visionFromChat(config) {
  const rt = resolveRuntime(config);
  const preset = rt.preset || PROVIDERS.custom;
  const list = preset.visionModels || [];
  const current = resolveVisionConfig(config) || {};
  // 聊天模型自己能看图就抄它；否则用这家服务商的预设视觉模型；再没有才沿用当前的，
  // 免得「聊天模型是纯文本、这家又没有视觉模型」时抄出一个空模型。
  const model = list.includes(rt.model) ? rt.model : (list[0] || String(current.model || '').trim());
  if (!model) {
    throw new Error('聊天的模型不能看图，这家服务商也没有预设视觉模型：先把「模型」填一个看图模型名再复制');
  }
  return { baseUrl: rt.baseUrl, model };
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
  // 留空表示「不改」；以前设置里没有这个字段，填了也没地方存，于是永远提示未配置
  if (typeof body.visionApiKey === 'string') {
    const vk = body.visionApiKey.trim();
    if (vk && (/\s/.test(vk) || vk.length < 8 || vk.length > 300)) {
      throw new Error('看图 API Key 看起来不太对：不能有空格，长度 8~300');
    }
    if (vk) patch.visionApiKey = vk;
  }
  // 看图模型：聊天模型本身能看图时自动跟随它（用户手动选过就以手动为准）。
  // 以前只有 config.json 的 vision.model，切到能看图的聊天模型后还要再去「看图」里改一遍，
  // 忘了改就会出现「聊天模型是 GLM-4.6V、看图还在用别的模型」。
  {
    const nextProvider = patch.provider || current.provider;
    const nextModel = patch.model || current.model;
    const nextPreset = PROVIDERS[nextProvider] || PROVIDERS.custom;
    const savedSettings = loadSettings(config);
    // 「从聊天复制」优先于手填：一键把地址/模型搬过来，之后照样能在界面上改
    const fromChat = body.visionCopyFromChat === true ? visionFromChat(config) : null;
    const vp = decideVisionPatch({
      preset: nextPreset,
      nextModel,
      saved: savedSettings,
      manualValue: fromChat ? fromChat.model : (typeof body.visionModel === 'string' ? body.visionModel : null),
      manualProvider: fromChat ? 'custom' : (typeof body.visionProvider === 'string' ? body.visionProvider : null),
      manualBaseUrl: fromChat ? fromChat.baseUrl : (typeof body.visionBaseUrl === 'string' ? body.visionBaseUrl : null),
    });
    if (vp) Object.assign(patch, vp);
  }
  if (typeof body.mock === 'boolean') patch.mock = body.mock;
  // 「怎么称呼你」：以前只存在浏览器 localStorage 里，换设备就丢；现在写进 data/settings.json
  if (typeof body.userName === 'string') patch.userName = body.userName.trim().slice(0, 24);
  // 只要这次填了 Key，就默认关闭演示模式（防止「有 Key 还在说内置台词」）
  if (patch.apiKey) patch.mock = false;
  // 目标服务本来就不需要 Key（本地 Ollama / 本机 / 内网自建）时，演示模式一律关掉。
  // 设置页每次都会把开关一起提交，新装用户默认就勾着 —— 以前这里被 body.mock 覆盖回 true，
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
  // 深度思考：只接受布尔值（界面开关）；落进 data/settings.json，resolveRuntime 优先读它。
  // 思考 token 计入 max_tokens，开着会明显变慢、变贵，所以默认关。
  if (typeof body.thinking === 'boolean') patch.thinking = body.thinking;
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
  // 称呼：设置界面和接口改的是同一份数据，写进 config.json，重启也不会被旧值盖回来
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
      thinking: llm.thinking === true,
      userName: String(config.persona.ownerName || '主人'),
      // 保存后前端立刻能把「看图 Key 已存」显示出来
      vision: vision.status(config),
    },
  };
}

module.exports = { getSettings, applySettings, decideVisionPatch, visionFromChat };
