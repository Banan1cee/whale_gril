'use strict';

/**
 * 提示词里的 <env> 块：把「这台机器是什么样」这类稳定信息交给模型。
 *
 * 起因：问她「你用的什么系统 / 你那边几点了 / 你电脑卡不卡」，模型只能按训练数据猜。
 * 但这类信息一旦拼错位置，代价是双份的：
 *   1. 进了静态 system 就要求**逐字节稳定**，否则每轮都在打碎前缀缓存；
 *   2. 进 system 的每个字段都会跟着请求发到模型接口，所以主机名/用户名/路径一个都不能带。
 *
 * 这一组用例把「该有的字段在」「不该有的字段一个都不在」「同一配置下两次拼出来一模一样」
 * 三件事钉住。隐私断言不是形式主义：`formatBlock` 的输入只有快照，宿主信息根本没进来。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const env = require('../src/core/env');
const envInfo = require('../src/services/envInfo');
const persona = require('../src/persona');
const { DEFAULT_CONFIG } = require('../src/infra/config');

const VERSION = '4.0';

/** 和运行时一样从 DEFAULT_CONFIG 起步，只覆盖要用到的段 */
function config(extra = {}) {
  return Object.assign({}, DEFAULT_CONFIG, {
    persona: Object.assign({}, DEFAULT_CONFIG.persona, {
      name: '鲸鲸',
      aliases: ['鲸鲸', '鲸娘'],
      ownerName: '主人',
      master: { names: ['Master'], wxids: ['wxid_test_master'] },
    }),
    chat: Object.assign({}, DEFAULT_CONFIG.chat),
    websearch: Object.assign({}, DEFAULT_CONFIG.websearch),
    env: Object.assign({}, DEFAULT_CONFIG.env),
    features: Object.assign({}, DEFAULT_CONFIG.features),
  }, extra);
}

function buildAt(cfg, date, envBlock) {
  return persona.buildSystem({
    config: cfg,
    msg: { chatType: 'private', senderName: '小海', chatTitle: '深海鱼塘' },
    now: date,
    envBlock,
  });
}

/** data/ 里一个文件都不该多出来：环境信息只活在内存里 */
function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/* ---------------- formatBlock ---------------- */

test('formatBlock：字段齐全，长成 <env> 块', () => {
  const snap = env.snapshot();
  const block = env.formatBlock(snap, { location: '上海市浦东新区', version: VERSION });
  assert.ok(block.startsWith('<env>'), '要以 <env> 开头');
  assert.ok(block.endsWith('</env>'), '要以 </env> 结尾');
  assert.match(block, /^所在地：上海市浦东新区$/m);
  assert.match(block, /^系统：\S/m);
  assert.match(block, /^架构：.*CPU \d+ 核.*内存 \d+ GB$/m);
  assert.match(block, /^时区：\S+/m);
  assert.match(block, new RegExp('^Node：' + process.version.replace(/\./g, '\\.') + ' · 程序版本 4\\.0$', 'm'));
  // 快照里的每一段都得真的拼进去，不能出现空值
  assert.ok(block.includes(snap.osName), '缺系统名');
  assert.ok(block.includes(String(snap.cpuCores)), '缺核数');
});

test('formatBlock：location 为空就整行不写（不是写个「未知」）', () => {
  const block = env.formatBlock(env.snapshot(), { location: '', version: VERSION });
  assert.doesNotMatch(block, /所在地/, '没有地点时不该出现「所在地」这一行');
  assert.match(block, /^系统：/m, '其它行照常');
});

test('formatBlock：不含主机名 / 家目录 / 用户名', () => {
  const block = env.formatBlock(env.snapshot(), { location: '上海市浦东新区', version: VERSION });
  const secrets = [
    ['主机名', os.hostname()],
    ['家目录', os.homedir()],
    ['用户名', process.env.USERNAME || (os.userInfo && os.userInfo().username) || ''],
    ['用户目录', process.env.USERPROFILE || ''],
  ];
  for (const [label, value] of secrets) {
    if (!value || String(value).length < 2) continue;
    assert.equal(block.includes(String(value)), false, `环境块里出现了${label}：${value}`);
  }
  // 顺带钉死：不能有盘符路径、IP、经纬度这种定位信息
  assert.doesNotMatch(block, /[A-Za-z]:\\/);
  assert.doesNotMatch(block, /\b\d{1,3}(\.\d{1,3}){3}\b/);
});

/* ---------------- 地点解析顺序 ---------------- */

/*
 * 下面出现的「上海市浦东新区 / 北京市海淀区 / 杭州市 / 厦门市同安区」都是**占位示例**
 * （取自需求里的样例地址），不是任何人的真实地址。
 * 探测相关的用例一律走 `location._setCacheForTest()`，不联网、不起子进程：
 * 「可以真的探」这件事由 app.js 启动时的 `startAutoProbe` 决定，单测里永远不触发。
 */

test('地点：env.location 优先于一切（含自动探测）', () => {
  const cfg = config({
    env: { location: '上海市浦东新区', timezone: '' },
    websearch: { enabled: true, city: '北京', timeoutMs: 8000 },
  });
  const probe = require('../src/services/location');
  probe._setCacheForTest({ text: '厦门市同安区', source: 'system', accuracyM: 80 });
  try {
    assert.equal(envInfo.resolveLocation(cfg), '上海市浦东新区');
    // 手填的不带括注，保持和以前一样的形状
    assert.match(envInfo.systemBlock(cfg, VERSION), /^所在地：上海市浦东新区$/m);
  } finally {
    probe._clearForTest();
  }
});

test('地点：env.location 为空时退回 websearch.city', () => {
  const cfg = config({
    env: { location: '', timezone: '' },
    websearch: { enabled: true, city: '杭州', timeoutMs: 8000 },
  });
  assert.equal(envInfo.resolveLocation(cfg), '杭州');
  assert.match(envInfo.systemBlock(cfg, VERSION), /^所在地：杭州$/m);
});

test('地点：配置都为空时才用自动探测，并写明来源和「只到市」', () => {
  const probe = require('../src/services/location');
  const cfg = config({ env: { location: '', timezone: '' }, websearch: { enabled: true, city: '', timeoutMs: 8000 } });
  probe._setCacheForTest({ text: '厦门市', source: 'system', accuracyM: 80 });
  try {
    const block = envInfo.systemBlock(cfg, VERSION);
    assert.match(block, /^所在地：厦门市（系统定位，精度约 80 米，只到市）$/m);
  } finally {
    probe._clearForTest();
  }
});

test('地点：自动探测只到市 —— 定位再准也不写区县（落点会偏到隔壁区）', () => {
  const probe = require('../src/services/location');
  const cfg = config({ env: { location: '', timezone: '' }, websearch: { enabled: true, city: '', timeoutMs: 8000 } });
  probe._setCacheForTest({ text: '厦门市', source: 'system', accuracyM: 30 });
  try {
    const block = envInfo.systemBlock(cfg, VERSION);
    assert.match(block, /^所在地：厦门市（系统定位，精度约 30 米，只到市）$/m);
    // 实测定位点会落到隔壁区，所以自动探测一个区名都不许出现
    assert.doesNotMatch(block, /同安|思明|湖里|集美|海沧|翔安/, '自动探测不许点名到区');
  } finally {
    probe._clearForTest();
  }
});

test('地点：精度很粗（50 公里）时括注照样写出来', () => {
  const probe = require('../src/services/location');
  const cfg = config({ env: { location: '', timezone: '' }, websearch: { enabled: true, city: '', timeoutMs: 8000 } });
  probe._setCacheForTest({ text: '厦门市', source: 'system', accuracyM: 50000 });
  try {
    assert.match(envInfo.systemBlock(cfg, VERSION), /^所在地：厦门市（系统定位，精度约 50 公里，只到市）$/m);
  } finally {
    probe._clearForTest();
  }
});

test('地点：退回出口 IP 时必须写明「挂 VPN 可能不符」', () => {
  const probe = require('../src/services/location');
  const cfg = config({ env: { location: '', timezone: '' }, websearch: { enabled: true, city: '', timeoutMs: 8000 } });
  probe._setCacheForTest({ text: '厦门', source: 'ip', accuracyM: 0 });
  try {
    const block = envInfo.systemBlock(cfg, VERSION);
    assert.match(block, /^所在地：厦门（按网络出口 IP 推算，挂了 VPN 时可能不符）$/m);
  } finally {
    probe._clearForTest();
  }
});

test('地点：探测结果里混进街道门牌也要被砍掉', () => {
  const probe = require('../src/services/location');
  const cfg = config({ env: { location: '', timezone: '' }, websearch: { enabled: true, city: '', timeoutMs: 8000 } });
  probe._setCacheForTest({ text: '深圳市南山区粤海街道科技园 1 号', source: 'system', accuracyM: 60 });
  try {
    const block = envInfo.systemBlock(cfg, VERSION);
    assert.match(block, /^所在地：深圳市南山区/m);
    assert.doesNotMatch(block, /科技园|街道|1 号/);
  } finally {
    probe._clearForTest();
  }
});

test('地点：env.autoDetect=false 时不采用探测结果', () => {
  const probe = require('../src/services/location');
  const cfg = config({ env: { location: '', timezone: '', autoDetect: false }, websearch: { enabled: true, city: '', timeoutMs: 8000 } });
  probe._setCacheForTest({ text: '厦门市', source: 'system', accuracyM: 80 });
  try {
    assert.equal(envInfo.resolveLocation(cfg), '');
    assert.doesNotMatch(envInfo.systemBlock(cfg, VERSION), /所在地/);
  } finally {
    probe._clearForTest();
  }
});

test('探测：默认只拼到市，要区得显式 allowDistrict；拼接与括注是纯函数', () => {
  const probe = require('../src/services/location');
  const admin = { province: '福建省', city: '厦门市', district: '同安区' };
  // 默认（自动探测走这条）：只到市，跟精度无关
  assert.equal(probe.composeLocation(admin, 80), '厦门市');
  assert.equal(probe.composeLocation(admin, 50000), '厦门市');
  // 显式要求 + 精度够好，才带区
  assert.equal(probe.composeLocation(admin, 80, { allowDistrict: true }), '厦门市同安区');
  assert.equal(probe.composeLocation(admin, 50000, { allowDistrict: true }), '厦门市');
  assert.equal(probe.composeLocation({ province: '福建省', city: '厦门市' }, 80), '厦门市');
  // 直辖市别拼成「北京市北京市」
  assert.equal(probe.composeLocation({ province: '北京市', city: '北京市', district: '朝阳区' }, 80), '北京市');
  assert.equal(probe.composeLocation({ province: '北京市', city: '北京市', district: '朝阳区' }, 80, { allowDistrict: true }), '北京市朝阳区');
  // 什么都没有就是空串
  assert.equal(probe.composeLocation({}, 80), '');
  assert.equal(probe.composeLocation(null, 80), '');
  // 括注三种来源
  assert.match(probe.noteFor('system', 80), /系统定位，精度约 80 米/);
  assert.match(probe.noteFor('system', 50000), /只到市/);
  assert.match(probe.noteFor('ip', 0), /出口 IP/);
  assert.equal(probe.noteFor('manual', 0), '');
});

test('地点：两个都为空又没有探测结果 → 整行不出现', () => {
  const cfg = config({ env: { location: '', timezone: '' }, websearch: { enabled: true, city: '', timeoutMs: 8000 } });
  assert.equal(envInfo.resolveLocation(cfg), '');
  const block = envInfo.systemBlock(cfg, VERSION);
  assert.match(block, /<env>/);
  assert.doesNotMatch(block, /所在地/);
});

test('地点：比「区」更细的地址会被砍掉（红线：最多到区）', () => {
  for (const [input, expected] of [
    ['上海市浦东新区张江路 1 号', '上海市浦东新区'],
    ['北京市海淀区中关村大街 5 号院', '北京市海淀区'],
    ['深圳市南山区粤海街道', '深圳市南山区'],
    ['上海市浦东新区', '上海市浦东新区'],
  ]) {
    assert.equal(envInfo.clampLocation(input), expected, input);
  }
  // 经纬度不进来
  assert.equal(envInfo.clampLocation('31.2304, 121.4737'), '');
});

/* ---------------- snapshot ---------------- */

test('snapshot：两次调用是同一个对象（memoized）', () => {
  const a = env.snapshot();
  const b = env.snapshot();
  assert.equal(a, b, '应该返回缓存里的同一份，而不是每次重新采');
  assert.deepEqual(a, b);
});

test('snapshot：字段固定，且没有时间类字段', () => {
  const snap = env.snapshot();
  assert.deepEqual(
    Object.keys(snap).sort(),
    ['arch', 'cpuCores', 'memGB', 'node', 'osName', 'osVersion', 'tz'],
    '字段一旦变多，就得先想清楚是不是又把「此刻」塞进静态块了'
  );
  for (const key of Object.keys(snap)) {
    assert.doesNotMatch(key, /time|date|now|ts$|uptime|clock/i, `快照里不该有时间类字段：${key}`);
  }
  assert.equal(typeof snap.osName, 'string');
  assert.ok(snap.cpuCores > 0);
  assert.ok(snap.memGB > 0);
});

/* ---------------- 开关 ---------------- */

test('features.envContext=false：system 里没有 <env>（调用方传了字符串也不认）', () => {
  const on = config();
  const block = envInfo.systemBlock(on, VERSION);
  assert.match(block, /<env>/);
  assert.match(buildAt(on, new Date(2026, 10, 3, 10, 0, 0), block), /<env>/);

  const off = config({ features: Object.assign({}, DEFAULT_CONFIG.features, { envContext: false }) });
  assert.equal(envInfo.systemBlock(off, VERSION), '', '关掉后 systemBlock 自己就该返回空串');
  const sys = buildAt(off, new Date(2026, 10, 3, 10, 0, 0), block);
  assert.doesNotMatch(sys, /<env>/, '开关关掉后 system 里不许再有 <env>');
  assert.doesNotMatch(sys, /所在地：/, '连所在地那一行也不该在');
});

test('关掉环境块不影响别的内容（回到旧行为，不能缺胳膊少腿）', () => {
  const on = config();
  const off = config({ features: Object.assign({}, DEFAULT_CONFIG.features, { envContext: false }) });
  const date = new Date(2026, 10, 3, 10, 0, 0);
  const withEnv = buildAt(on, date, envInfo.systemBlock(on, VERSION));
  const without = buildAt(off, date, '');
  // 把环境块那几行去掉，剩下的必须完全一致
  const stripped = withEnv.replace(/\n\n<env>[\s\S]*?<\/env>\n【环境】[^\n]*/, '');
  assert.equal(stripped, without);
});

/* ---------------- 字节稳定 ---------------- */

test('system 字节稳定：同一分钟内不同 now 拼出来一模一样', () => {
  const cfg = config();
  const block = envInfo.systemBlock(cfg, VERSION);
  const a = buildAt(cfg, new Date(2026, 10, 3, 10, 0, 5), block);
  const b = buildAt(cfg, new Date(2026, 10, 3, 10, 0, 55), block);
  assert.equal(a, b, '同一个配置、同一分钟内，system 必须逐字节一致');
});

test('system 里的 <env> 块跟 now 无关：隔几个小时也是同一段字节', () => {
  const cfg = config();
  const block = envInfo.systemBlock(cfg, VERSION);
  const grab = (date) => {
    const m = buildAt(cfg, date, block).match(/<env>[\s\S]*?<\/env>/);
    assert.ok(m, '找不到 <env> 块');
    return m[0];
  };
  // 【此刻】那一行本来就该随轮次变，但静态环境块不许带任何时间
  assert.equal(grab(new Date(2026, 10, 3, 1, 5, 0)), grab(new Date(2026, 10, 3, 23, 55, 0)));
  assert.equal(grab(new Date(2026, 10, 3, 9, 0, 0)), block);
});

test('systemBlock 记忆化：同配置两次调用是同一个字符串', () => {
  const cfg = config({ env: { location: '上海市浦东新区', timezone: '' } });
  const a = envInfo.systemBlock(cfg, VERSION);
  const b = envInfo.systemBlock(cfg, VERSION);
  assert.equal(a, b);
  assert.equal(typeof a, 'string');
});

/* ---------------- 桥接状态 ---------------- */

test('bridgeLine：在线 + UIA 正常', () => {
  const line = envInfo.bridgeLine({ bridgeStatus: { online: true, uia: true, ffmpeg: true } });
  assert.match(line, /桥接在线/);
  assert.match(line, /UIA 可用/);
  assert.match(line, /ffmpeg 已找到/);
  assert.equal(line.includes('离线'), false);
});

test('bridgeLine：在线但 UIA 不可用', () => {
  const line = envInfo.bridgeLine({ bridgeStatus: { online: true, uia: false, ffmpeg: false } });
  assert.match(line, /桥接在线/);
  assert.match(line, /UIA 不可用/);
  assert.match(line, /ffmpeg 没找到/);
});

test('bridgeLine：离线', () => {
  const line = envInfo.bridgeLine({ bridgeStatus: { online: false, uia: null, ffmpeg: null } });
  assert.match(line, /桥接离线/);
  // 掉线时不该再声称 UIA / ffmpeg 状态（心跳早停了，说的都是旧值）
  assert.doesNotMatch(line, /UIA|ffmpeg/);
});

test('bridgeLine：没有 bridgeStatus（网页通道 / 测试）返回空串', () => {
  assert.equal(envInfo.bridgeLine({}), '');
  assert.equal(envInfo.bridgeLine({ bridgeStatus: null }), '');
  assert.equal(envInfo.bridgeLine(undefined), '');
  assert.equal(envInfo.bridgeLine({ bridgeStatus: 'online' }), '');
});

/* ---------------- 不落盘 ---------------- */

test('环境块不会被写进 data/ 下的任何文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-env-'));
  try {
    const cfg = config({ paths: { dataDir: dir } });
    const block = envInfo.systemBlock(cfg, VERSION);
    assert.match(block, /<env>/);
    // 完整走一遍拼装：谁要是顺手 mkdir/writeFile，这里就会多出文件来
    const system = buildAt(cfg, new Date(2026, 10, 3, 10, 0, 0), block);
    assert.match(system, /<env>/);
    envInfo.bridgeLine({ bridgeStatus: { online: true, uia: true, ffmpeg: true } });
    assert.deepEqual(walkFiles(dir), [], '环境信息只该在内存里，data/ 下不许落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('仓库 data/ 里也没有环境块痕迹（真跑过也不许留档）', () => {
  const dataDir = path.join(__dirname, '..', 'data');
  const files = walkFiles(dataDir);
  if (!files.length) return; // 干净检出本来就没有 data/
  const hits = [];
  for (const file of files) {
    if (!/\.(json|jsonl|log|txt|md)$/i.test(file)) continue;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('<env>') || text.includes('所在地：')) hits.push(path.relative(path.join(__dirname, '..'), file));
  }
  assert.deepEqual(hits, [], 'data/ 里出现了环境块内容，说明有地方把它写盘了');
});
