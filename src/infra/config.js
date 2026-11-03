'use strict';

/**
 * 配置加载：默认值 <- config.json <- 环境变量；用户面板设置保存在 data/settings.json。
 * 全部使用同步读取，启动时一次性完成，之后不再读盘。
 *
 * 模型服务是「可插拔」的：任何 OpenAI 兼容接口都能用（DeepSeek / 智谱 / 硅基流动 /
 * 通义千问 / 本地 Ollama / 你自己的服务）。配置见 PROVIDERS。
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * 模型服务预设。needsKey 表示必须填 API Key；本地地址（localhost/内网）会自动免 Key。
 * 新增服务只要往这里加一项。
 */
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek 官方（V4.1 Flash / V4 Pro）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    needsKey: true,
    hint: '在 platform.deepseek.com 创建 Key。deepseek-flash 便宜且支持看图，deepseek-v4-pro 更强但只收文本；旧名 deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    // deepseek-flash 在官方文档里 Vision 一栏是 ✓（V4 Pro 明确不支持）
    visionModels: ['deepseek-flash'],
  },
  zhipu: {
    label: '智谱 GLM（含免费文本 / 免费视觉）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7-flash',
    needsKey: true,
    hint: 'bigmodel.cn 注册拿 Key。默认免费文本 glm-4.7-flash，旗舰 glm-5.3（只收文本）；免费视觉 glm-4.6v-flash，原生多模态的 glm-5.3-flash 也能当聊天模型',
    models: ['glm-4.7-flash', 'glm-5.3', 'glm-4.7', 'glm-4.5-air', 'glm-4.6v-flash', 'glm-5.3-flash'],
    // 这些模型本身就能收图片：选中它们当聊天模型时，看图模型自动同步成同一个，
    // 不用再手动去「看图」里改一遍（启动器会显示当前跟随的是哪个）。
    // glm-4.6v-flash 是免费视觉；glm-5.3-flash 是 GLM-5 系列首个原生多模态模型。
    visionModels: ['glm-4.6v-flash', 'glm-5.3-flash'],
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow（有免费额度）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
    needsKey: true,
    hint: '注册送额度，模型名里带斜杠；例如 deepseek-ai/DeepSeek-V4.1-Flash',
    models: [
      'deepseek-ai/DeepSeek-V4.1-Flash',
      'deepseek-ai/DeepSeek-V4-Pro',
      'Qwen/Qwen3.8-27B',
      'zai-org/GLM-5.3-Flash',
      'moonshotai/Kimi-K2.7-Code',
    ],
    // 官方模型页：Qwen3.8-27B 是原生视觉语言模型，GLM-5.3-Flash 原生多模态
    visionModels: ['Qwen/Qwen3.8-27B', 'zai-org/GLM-5.3-Flash'],
  },
  qwen: {
    label: '通义千问 DashScope（有免费额度）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // 默认用免费额度最稳的 flash 档；plus / max 作为能力升级项。
    model: 'qwen3.8-flash',
    needsKey: true,
    hint: '阿里云百炼开通后拿 Key（sk- 开头）。默认 qwen3.8-flash（只收文本）；要更强还要能看图选 qwen3.7-plus 或 qwen3.8-max。报 429 就是额度/频率用完',
    models: ['qwen3.8-flash', 'qwen3.7-flash', 'qwen3.7-plus', 'qwen3.8-max'],
    // 百炼「视觉理解」列表里 qwen3.8-max / qwen3.7-plus 都在；qwen3.8-flash 只在文本生成里
    visionModels: ['qwen3.8-max', 'qwen3.7-plus'],
  },
  tju: {
    label: '天津大学 智能体广场（仅校内网）',
    baseUrl: 'https://ai.tju.edu.cn/api/v3',
    model: 'tju-llm',
    needsKey: true,
    hint: '需要校园网 / 学校 VPN；Base URL 为 https://ai.tju.edu.cn/api/v3，模型名 tju-llm',
    models: ['tju-llm'],
  },
  ollama: {
    label: '本地 Ollama（完全免费、可离线）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3:8b',
    needsKey: false,
    hint: '装 Ollama 后跑 ollama pull qwen3:8b；数据不出本机，不用 Key',
    models: ['qwen3:8b', 'llama3.1:8b'],
  },
  custom: {
    label: '自定义（任意 OpenAI 兼容接口）',
    baseUrl: '',
    model: '',
    needsKey: true,
    hint: '填接口地址和模型名；本地/内网地址可以不填 Key',
    models: [],
  },
  // OpenCode Go：一个订阅通吃多家模型（DeepSeek / GLM / Kimi / Qwen …），
  // 走它官方的 OpenAI 兼容端点。注意别填成 opencode.ai/zen/go/v1 ——
  // 那个是给 OpenCode 自家客户端用的，会回 400 "missing x-opencode-session"。
  opencode: {
    label: 'OpenCode Go（一个订阅通吃多家模型）',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    model: 'deepseek-v4.1-flash',
    needsKey: true,
    hint: '在 opencode.ai/console 订阅 Go 后拿 Key（oc_sk_ 开头）。国内账号需在 Settings › Privacy 把 Regions 选 Global，否则 DeepSeek 模型不可用',
    models: [
      'deepseek-v4.1-flash',
      'deepseek-v4-pro',
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.2',
      'kimi-k3.1-pro',
      'kimi-k3',
      'qwen3.8-max',
      'qwen3.8-flash',
      'qwen3.7-plus',
      'hy4-preview',
      'hy3',
      'step-5-preview',
      'minimax-m3.1-flash',
      'mimo-v2.6-flash',
      'longcat-2.0',
    ],
    // 代理的是各家原厂模型：DeepSeek flash / GLM-5.3-Flash / Kimi K3 系列 / Qwen max、plus 官方都支持图片输入
    visionModels: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k3.1-pro', 'kimi-k3', 'qwen3.8-max', 'qwen3.7-plus'],
  },
};

const DEFAULT_CONFIG = {
  provider: 'deepseek',
  server: { host: '127.0.0.1', port: 8787, openBrowser: false },  // 界面只有启动器，不再自动弹浏览器
  deepseek: {
    provider: 'deepseek',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    // 采样参数：以前是 temperature 1.15 + frequency_penalty 0.35 + presence_penalty 0.25。
    // 惩罚项会强迫模型避开常用词，温度又高，于是它去挑生僻搭配 —— 语法还是中文，
    // 语义全散了：句子开头通顺、越说越离谱、越说越长，最后撞上 max_tokens 被截断。
    // 表现就是「聊久了开始乱说话」。所以把惩罚项归零、温度降到自然档、输出给足。
    temperature: 0.95,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxTokens: 700,
    timeoutMs: 45000,
  },
  persona: {
    name: '鲸鲸',
    age: 23,
    job: '自由职业',
    appearance: '深蓝色长卷发，头发上别着一枚鲸尾发夹，常穿深蓝色水手领裙子，怀里或包里总有一只软乎乎的蓝鲸玩偶（你叫它小蓝鲸）。',
    personality: '温柔但有点小倔，嘴硬心软，慢热；熟了话很多，会害羞、会怼人、会犯懒、偶尔 emo。',
    background: '因为头像和玩偶全是鲸鱼，朋友开玩笑叫你「鲸鱼娘」，你也就认了。',
    aliases: ['鲸鲸', '小鲸娘', '鲸娘', '深鲸娘', '鲸鱼娘', '小鲸'],
    ownerName: '主人',
    // 主人名单：填你自己的昵称 / wxid，谁填谁就是主人（留空 = 没有主人）
    master: {
      names: [],
      wxids: [],
    },
    // 主人骂她时能不能还嘴（默认关：只许委屈不许骂回去）
    masterRoast: false,
  },
  chat: { privateMaxChars: 100, groupMaxChars: 70, historyTurns: 120, groupHistoryTurns: 100, maxBubbles: 2, discussionMaxChars: 400, emojiChance: 0 },
  // 联网：问天气/新闻这类实时问题时现搜。city 用来把「今天天气怎么样」补成「上海 天气」，
  // 搜到的结果准得多；留空就按对方原话搜（也能用，但经常搜到别的城市）。
  websearch: { enabled: true, city: '', timeoutMs: 8000 },
  // 环境：拼进提示词 <env> 块的稳定信息（开关在 features.envContext）。
  // location 是给人填的，可以精确到区（「厦门市思明区」）；留空就交给自动探测，
  // 探测也拿不到才退回 websearch.city（只有城市级），都没有就整行不写。
  // **不要填街道门牌**——拼装时会按区截断，但一开始就别填。
  // autoDetect：自动探测本机所在地。优先 Windows 定位服务（不吃公网 IP，挂 VPN 也是本机位置），
  // 只到市（区县容易错，要区就手填）；拿不到才退回出口 IP（会写明「按出口 IP」）。
  // 不想联网/不想起子进程就设 false。timezone 留空 = 用系统自己的时区。
  env: { location: '', timezone: '', autoDetect: true },
  // 提醒：规则和 care 同语义（每天上限 / 刚聊过先跳过），配置独立、界面独立。
  // 提醒不设时间段：它是用户指定的准点事件，卡时间窗只会让提醒发不出去。
  reminder: { enabled: true, maxPerDay: 0, quietAfterMinutes: 0 },
  // 别人发链接时，读一下标题/摘要/文章正文（视频只读得到文案）
  links: { enabled: true, timeoutMs: 6000, cacheMinutes: 60 },
  // 魔咒：主人私聊/群里输入这段数字后，获得一段时间的「管理员权限」
  admin: { spell: '', minutes: 30, allowAll: false },
  // 表情包（实验性）：总闸在 features.stickers，这里只管「怎么挑、发多勤」。
  // 关闭时整个功能不生效：不挑图、不回包带字段、桥接不轮询、测试接口 404。
  sticker: {
    dir: 'data/stickers',
    // 三类：傲娇 / 炸毛 / 其他。发哪一类由模型在回复里用 [[sticker:分类]] 决定，
    // 不再按概率自动发；自定义分类存在 data/sticker-categories.json（不进 config，
    // 避免被表单转成字符串）。
    testChat: '文件传输助手', // 控制台「发送测试表情包」默认发到哪
  },
  // 图片理解：默认智谱 GLM-4V-Flash（免费）
  features: {
    stickers: false,
    // 系统提示词静态化（前缀缓存）：关掉 = 回到「每轮都塞时间/心情/说话人」的旧行为
    staticSystem: true,
    // 环境信息注入（系统 / 时区 / 所在地）：关掉 = system 里没有 <env> 块
    envContext: true,
    groupAddressGuard: true,
    fightQuoteCheck: true,
    mediaCleanup: true,
    memorySnapshot: true,
    // 群聊关系加载（A 提到 B）：默认开，可在调试台关
    relations: true,
  },

  storage: {
    mediaKeepDays: 7,
    mediaMaxMB: 500,
  },

  vision: { apiKey: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6v-flash', timeoutMs: 30000 },
  // 语音识别：默认阿里云百炼 qwen3-asr-flash，apiKey 留空则用 settings.json / deepseek.apiKey
  voice: {
    enabled: true,
    apiKey: '',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    model: 'qwen3-asr-flash',
    timeoutMs: 90000,
    maxSeconds: 120,
  },
  // 主动搭话（没事时她自己来问一句「在干啥 / 累不累」）
  care: {
    // 默认：她自己来找你（只找主人），但绝不进群、也不主动找别人
    enabled: true,
    onlyMaster: true,
    allowGroups: false,
    allowOthers: false,
    // 白名单：留空 = 「主人 + 文件传输助手」。填了以后只认这份清单，
    // 群要额外开 allowGroups，非主人的私聊要额外开 allowOthers。
    whitelist: [],
    windows: ['09:00-12:00', '14:00-23:00'],
    everyMinutes: 90,
    jitterMinutes: 25,
    maxPerDay: 6,
    quietAfterMinutes: 20,
  },
  group: {
    requireAt: true,
    freeChat: false,
    freeChatChance: 0.06,
    cooldownSec: 0,
    masterAlwaysReply: true,
    engagedMinutes: 6,
    silentMinutes: 10,
    maxRepliesPerMinute: 15,
    muteDefaultMinutes: 30,
  },
  // 记忆参数以 src/memory/constants.js 为准（写死的那些不改）；
  // 唯一可调的是「对话预算」：config.json 的 memory.dialogueBudget，默认 5,500。
  // 启动器「高级模式 → 高级」里能改；旧的 memory.maxSessions / maxMessages 等仍然被忽略。
  memory: {
    // 对话预算（不含 system prompt）= memory 900 + summary 900 + recent 3,200 + reserve 500
    dialogueBudget: 5500,
  },
  // 微信桥接：account = 固定用哪个微信号（微信双开时必填）。启动器「微信桥接」页点账号卡会直接写这里，
  // 一般不用手改；留空 = 按「最近活跃」自动选（双开时可能选到大号）。
  wechat: {
    dbDir: '',
    account: '',
    accountGuard: true,
    windowHwnd: 0,
    // 零焦点发送通道（bridge/bg_sender.py）。桥接自己也会解析这一块，
    // 这里放默认值是为了：调试台能看到、configSchema 能校验、/api/status 能展示。
    bgSend: {
      enabled: true,
      charGapMs: 40,
      verify: true,
      fallbackToForeground: true,
      stripUnencodable: true,
      unhideWindow: true,
      // WM_CHAR 编码：auto = 按微信版本自动（4.2+ 用 UTF-16 码元，老版本用 GBK 字节）
      charMode: 'auto',
    },
    // 消息调度：同一会话串行、跨会话并发。workers=1 等于旧的全串行行为。
    pipelineWorkers: 4,
    pipelineQueueLimit: 8,
    // 这些会话永不回复（微信团队、订阅号…）。必须是数组：保存时按数组原样写回，
    // 缺省会退化成字符串，界面上再读就成了一整行。
    ignoreSenders: [],
  },
  gateway: {
    // 默认开：本地桥接就是走这个 webhook，关掉等于微信收发全停。
    // 启动器设置页已不再暴露这一组，改只能改 config.json。
    wechat: { enabled: true, inboundToken: 'change-me-wechat', outboundUrl: '', outboundHeaders: {} },
    douyin: { enabled: false, inboundToken: 'change-me-douyin', outboundUrl: '', outboundHeaders: {} },
  },
  // 日志：level 管控制台，fileLevel 管文件（默认 debug 全量）。
  // trace 记「为什么回/为什么不回」的判定链（不含正文）；traceRaw 在本地留 24 小时的原文副本，
  // 只有导出日志包时手动勾选才会带出去。
  log: { level: 'info', fileLevel: 'debug', trace: true, traceRaw: true },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 深拷贝：老实现只做 `{ ...base }` 浅拷贝，persona 这类嵌套对象会和
// DEFAULT_CONFIG 共享同一个引用 —— 一次「导入预设」就把模块级默认值改了，
// 同进程里之后新建的配置、以及测试之间都会互相污染。
function cloneDeep(value) {
  if (Array.isArray(value)) return value.map(cloneDeep);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneDeep(value[key]);
    return out;
  }
  return value;
}

function deepMerge(base, extra) {
  const out = cloneDeep(base);
  if (!isPlainObject(extra)) return out;
  for (const [k, v] of Object.entries(extra)) {
    if (k.startsWith('_')) continue; // 以 _ 开头的是说明字段，忽略
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function projectRoot(from = __dirname) {
  // src/infra/config.js → 项目根目录要往上两层
  return path.resolve(from, '..', '..');
}

/**
 * 本机 / 内网主机名（不带协议），这类服务通常不需要 API Key，比如 Ollama、LM Studio、vLLM。
 * `host.docker.internal` 是 Docker/WSL 里指向宿主机的固定名，`.local` 是局域网 mDNS。
 */
const LOCAL_HOST = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|[a-z0-9-]+\.local)`;
const LOCAL_NET = String.raw`(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})`;
// 主机部分之后必须紧跟端口 / 路径 / 结束，否则 127.0.0.10 会被认成 127.0.0.1
const LOCAL_HOST_RE = new RegExp(`^(?:${LOCAL_HOST}|${LOCAL_NET})(?::\\d+)?(?:[/?#]|$)`);

/** 本机或内网地址（这类服务通常不需要 API Key，比如 Ollama、LM Studio） */
function isLocalUrl(url) {
  const s = String(url || '').trim().toLowerCase();
  if (!/^https?:\/\//.test(s)) return false;
  return LOCAL_HOST_RE.test(s.replace(/^https?:\/\//, '').replace(/^[^/]*@/, ''));
}

/**
 * 用户少写协议（`127.0.0.1:11434/v1`）是很常见的，本机 / 内网地址自动补 http://。
 * 公网域名不补：补成 http 反而打不开（那些服务基本都只认 https）。
 */
function normalizeBaseUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return 'http:' + s;
  if (LOCAL_HOST_RE.test(s.toLowerCase().replace(/^[^/]*@/, ''))) return 'http://' + s;
  return s;
}

/**
 * @param {{root?: string, env?: NodeJS.ProcessEnv}} options
 */
/**
 * 老配置里的采样参数是「乱说话」的元凶，装好的人不会自己去改，
 * 所以这里做一次性迁移：只有当前值**恰好等于旧默认值**时才改（用户自己调过的不动）。
 *
 * 旧默认：temperature 1.15 + frequency_penalty 0.35 + presence_penalty 0.25 + max_tokens 320
 * 新默认：temperature 0.95、两个惩罚项归零、max_tokens 700
 */
const LEGACY_SAMPLING = { temperature: 1.15, frequencyPenalty: 0.35, presencePenalty: 0.25, maxTokens: 320 };
// 网页设置面板（「俏皮程度」滑块）以前默认就是 1.25，存过设置的人会被它盖住
const LEGACY_TEMPERATURES = [1.15, 1.25];

function migrateSampling(cfg, log) {
  const ds = cfg.deepseek || (cfg.deepseek = {});
  const same = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
  const untouched =
    same(ds.temperature, LEGACY_SAMPLING.temperature) &&
    same(ds.frequencyPenalty, LEGACY_SAMPLING.frequencyPenalty) &&
    same(ds.presencePenalty, LEGACY_SAMPLING.presencePenalty);
  if (!untouched) return false;
  ds.temperature = DEFAULT_CONFIG.deepseek.temperature;
  ds.frequencyPenalty = DEFAULT_CONFIG.deepseek.frequencyPenalty;
  ds.presencePenalty = DEFAULT_CONFIG.deepseek.presencePenalty;
  if (same(ds.maxTokens, LEGACY_SAMPLING.maxTokens)) ds.maxTokens = DEFAULT_CONFIG.deepseek.maxTokens;
  if (typeof log === 'function') {
    log('采样参数已从旧默认值升级：惩罚项 0.35/0.25 → 0，温度 1.15 → 0.95，避免「聊久了乱说话」');
  }
  return true;
}

function loadConfig({ root = projectRoot(), env = process.env } = {}) {
  const configPath = path.join(root, 'config.json');
  const configExists = fs.existsSync(configPath);
  const fromFile = configExists ? readJson(configPath, {}) : {};
  const cfg = deepMerge(DEFAULT_CONFIG, fromFile);
  // 表情包不再按概率发送（分类由模型标记决定），旧的 chances / genericChance
  // 即使还留在 config.json 里也不参与运行，这里不再做任何兼容搬移。
  // 老配置迁移（在 env 覆盖之前做，避免把用户的 env 设置改掉）
  const migrated = migrateSampling(cfg);
  if (migrated && configExists) {
    // 顺手写回文件，免得用户打开 config.json 看到的还是旧参数
    try {
      const raw = readJson(configPath, null);
      if (raw && raw.deepseek) {
        raw.deepseek.temperature = cfg.deepseek.temperature;
        raw.deepseek.frequencyPenalty = cfg.deepseek.frequencyPenalty;
        raw.deepseek.presencePenalty = cfg.deepseek.presencePenalty;
        if (Math.abs(Number(raw.deepseek.maxTokens) - LEGACY_SAMPLING.maxTokens) < 1e-9) {
          raw.deepseek.maxTokens = cfg.deepseek.maxTokens;
        }
        const tmp = configPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, configPath);
      }
    } catch { /* 写不了就算了，内存里已经生效 */ }
  }
  cfg.server.port = Number(env.PORT || cfg.server.port) || 8787;
  cfg.server.host = env.HOST || cfg.server.host;
  if (env.DEEPSEEK_MODEL) cfg.deepseek.model = env.DEEPSEEK_MODEL;
  if (env.DEEPSEEK_BASE_URL) cfg.deepseek.baseUrl = env.DEEPSEEK_BASE_URL;
  if (env.LLM_PROVIDER) cfg.provider = env.LLM_PROVIDER;
  // config.env 一直是「进程环境变量」的视图（vision.js 读 ZHIPU_API_KEY、Key 兜底读 DEEPSEEK_API_KEY），
  // 而 config.json 的 env 段放的是环境块要用的 location / timezone / autoDetect。以前这里直接把
  // process.env 顶上去，config.json 里写的 env 段被整个盖掉 —— 填了地点也不生效。
  // 现在用原型链合起来：环境变量从原型读（不复制整份，Windows 上的大小写不敏感查表也照样有效），
  // config.json 的值是自己的键，序列化配置时不会把整份环境变量带出去。
  const fileEnv = cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env) ? { ...cfg.env } : {};
  const mergedEnv = Object.assign(Object.create(env || null), fileEnv);
  return {
    ...cfg,
    root,
    paths: {
      root,
      dataDir: path.join(root, 'data'),
      configFile: configPath,
      settingsFile: path.join(root, 'data', 'settings.json'),
      storeFile: path.join(root, 'data', 'store.json'),
      logFile: path.join(root, 'data', 'whale.log'),
      webDir: path.join(root, 'web'),
    },
    env: mergedEnv,
    configExists,
  };
}

/** 首次运行时生成 config.json，方便用户直接编辑 */
function ensureConfigFile(root = projectRoot()) {
  const target = path.join(root, 'config.json');
  if (fs.existsSync(target)) return target;
  const example = path.join(root, 'config.example.json');
  if (fs.existsSync(example)) fs.copyFileSync(example, target);
  return target;
}

function loadSettings(cfg) {
  return readJson(cfg.paths.settingsFile, {}) || {};
}

function saveSettings(cfg, patch) {
  const current = loadSettings(cfg);
  const next = { ...current, ...patch };
  // 每个服务商各存一把 Key，切换服务商时自动取对应那把，避免把智谱的 Key 拿去打 DeepSeek
  // patch 里显式带的 keys 也要合进来，否则一次 saveSettings 就把别的服务商的 Key 丢了，
  // 切换备用服务商时找不到能用的 Key
  const keys = { ...(current.keys || {}) };
  const previousProvider = String(current.provider || cfg.provider || (cfg.deepseek || {}).provider || 'deepseek');
  const previousKey = Object.prototype.hasOwnProperty.call(current, 'apiKey') ? current.apiKey :
    (cfg.llm || {}).apiKey || (previousProvider === 'deepseek' ? (cfg.deepseek || {}).apiKey || (cfg.env || {}).DEEPSEEK_API_KEY : '') || '';
  if (previousKey && !keys[previousProvider]) keys[previousProvider] = previousKey;
  for (const [name, value] of Object.entries((patch && patch.keys) || {})) {
    if (name && value) keys[name] = String(value).trim();
  }
  const providerName = String(next.provider || previousProvider).trim();
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
    next.apiKey = String(patch.apiKey || '').trim();
    if (providerName) {
      if (next.apiKey) keys[providerName] = next.apiKey;
      else delete keys[providerName];
    }
  } else if (providerName && providerName !== previousProvider) {
    next.apiKey = keys[providerName] || '';
  }
  next.keys = keys;
  fs.mkdirSync(cfg.paths.dataDir, { recursive: true });
  fs.writeFileSync(cfg.paths.settingsFile, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 看图（视觉）最终生效的地址与模型：面板设置（data/settings.json）> config.json > 默认。
 * 面板里存 visionModel 是为了「聊天模型能看图时自动跟随」——以前只有 config.json 的
 * vision.model 一个来源，自动跟随就没地方落盘。
 */
function resolveVisionConfig(cfg) {
  const c = cfg || {};
  // 单元测试会直接传一个只有 vision 段的假 config（没有 paths），别因为读不到
  // settings.json 就抛错——看图应该退回 config 里的值继续工作。
  const settings = c.paths && c.paths.settingsFile ? loadSettings(c) : {};
  const v = c.vision || {};
  const hasModel = Boolean(String(settings.visionModel || '').trim());
  // manual=true 表示用户自己选过看图模型；false 表示「自动跟随聊天模型」。
  // 自动跟随时 visionModel 也有值，所以要看 visionManual 这个显式标记；
  // 没有这个标记的老设置（只写了 visionModel）按手动处理。
  // 自定义接口（visionProvider=custom）天然是手动：地址和模型都是用户自己填的。
  const customVision = settings.visionAuto !== true && String(settings.visionProvider || '').trim() === 'custom';
  const manual = customVision || settings.visionManual === true || (hasModel && settings.visionManual === undefined);
  let model = String(settings.visionModel || v.model || 'glm-4.6v-flash').trim();
  let baseUrl = String(settings.visionBaseUrl || v.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').trim();
  let auto = settings.visionAuto === true;
  // 手动模式下用户可能指定了「看图服务商」（跟聊天页一样先选服务商再选模型）。
  // 自动模式下服务商就是聊天服务商，不用单独存。
  let provider = auto ? '' : String(settings.visionProvider || '').trim();
  // 还没跟随过（新装 / 刚切到不能看图的聊天模型）时，优先用当前服务商自己的看图模型：
  // 这样一把 Key 就能看图，不会退回需要智谱 Key 的默认模型。
  if (!manual && !auto && hasModel === false && c.paths) {
    try {
      const rt = resolveRuntime(c);
      const fallback = ((rt.preset && rt.preset.visionModels) || [])[0] || '';
      if (fallback) {
        model = fallback;
        baseUrl = String(rt.preset.baseUrl || baseUrl);
        auto = true;
        provider = '';
      }
    } catch { /* 取不到服务商信息就按原值 */ }
  }
  return { ...v, model, baseUrl, manual, auto, provider };
}

/**
 * 计算最终生效的运行参数：面板设置 > config.json > 环境变量 > 服务预设。
 */
function resolveRuntime(cfg) {
  const settings = loadSettings(cfg);
  const legacy = cfg.deepseek || {};
  const llmCfg = cfg.llm || {};
  const provider = String(settings.provider || cfg.provider || legacy.provider || 'deepseek');
  const preset = PROVIDERS[provider] || PROVIDERS.custom;
  const envKey = (cfg.env && cfg.env.DEEPSEEK_API_KEY) || '';
  // 显式清空不能回退到另一服务的配置密钥。
  const configuredProvider = String(cfg.provider || legacy.provider || 'deepseek');
  const apiKey = String(Object.prototype.hasOwnProperty.call(settings, 'apiKey')
    ? settings.apiKey
    : (settings.keys && settings.keys[provider]) ||
      (provider === configuredProvider ? llmCfg.apiKey : '') ||
      (provider === 'deepseek' ? legacy.apiKey || envKey : '') || '').trim();
  // 只有 provider 确实是 deepseek 时，才沿用 deepseek 段里的地址/模型
  const legacyRelevant = provider === 'deepseek';
  const baseUrl = String(
    settings.baseUrl || llmCfg.baseUrl || (legacyRelevant ? legacy.baseUrl : '') || preset.baseUrl || ''
  ).trim();
  const model = String(
    settings.model || llmCfg.model || (legacyRelevant ? legacy.model : '') || preset.model || ''
  ).trim();
  const rawTemperature =
    typeof settings.temperature === 'number'
      ? settings.temperature
      : typeof legacy.temperature === 'number'
        ? legacy.temperature
        : DEFAULT_CONFIG.deepseek.temperature;
  // 设置面板（data/settings.json）的优先级最高，老版本会把旧默认 1.15 / 1.25 存在这里。
  // 只对「恰好等于旧默认值」的情况做归一，用户自己调过的不动。
  const legacyTemperature = LEGACY_TEMPERATURES.includes(Number(rawTemperature));
  const temperature = legacyTemperature ? DEFAULT_CONFIG.deepseek.temperature : rawTemperature;
  if (legacyTemperature && typeof settings.temperature === 'number') {
    // 顺手把设置面板里那个旧默认改掉，否则页面上显示的数值和实际生效的不一致
    try {
      settings.temperature = temperature;
      saveSettings(cfg, { ...settings });
    } catch { /* 写不了就算了 */ }
  }
  const local = isLocalUrl(baseUrl);
  const needsKey = provider === 'ollama' ? false : preset.needsKey && !local;
  const explicitMock = typeof settings.mock === 'boolean' ? settings.mock : null;
  // 「演示模式」只是「没有 Key 时的兜底」，不能反过来把本来能用的接口挡在门外：
  // 目标服务不需要 Key（本地 Ollama / 本机 / 内网自建）而且地址已经填好，就一律当真接入。
  // 之前这里直接信 settings.mock，于是「新装默认勾着演示模式」的用户选完本地模型，
  // 一次请求都不会发到本地服务，还一直提示「还没拿到 API Key」。
  const keyFree = !needsKey && /^https?:\/\//i.test(baseUrl);
  const mock = keyFree
    ? false
    : explicitMock === null
      ? !apiKey && needsKey
      : explicitMock;
  return {
    settings,
    provider,
    preset,
    providerLabel: preset.label,
    apiKey,
    baseUrl,
    model,
    temperature,
    mock,
    needsKey,
    isLocal: local,
  };
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return key.slice(0, 2) + '****';
  return `${key.slice(0, 5)}****${key.slice(-4)}`;
}

module.exports = {
  DEFAULT_CONFIG,
  PROVIDERS,
  LEGACY_SAMPLING,
  migrateSampling,
  isLocalUrl,
  normalizeBaseUrl,
  LOCAL_HOST_RE,
  loadConfig,
  ensureConfigFile,
  loadSettings,
  saveSettings,
  resolveRuntime,
  resolveVisionConfig,
  maskKey,
  deepMerge,
  readJson,
  projectRoot,
};
