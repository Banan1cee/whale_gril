'use strict';

/**
 * 图片识别：提示词要够细，桥接要拿完整图而不是缩略图。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const visionSrc = fs.readFileSync(path.join(root, 'src', 'vision.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(root, 'examples', 'wechatauto_bridge.py'), 'utf8');

test('视觉提示词要求逐条转写，并且分清左右气泡', () => {
  assert.match(visionSrc, /对方：/, '要教它标「对方：」');
  assert.match(visionSrc, /本人：/, '要教它标「本人：」');
  assert.match(visionSrc, /左边气泡|左边/, '要按气泡位置判断说话人');
  assert.match(visionSrc, /逐条转写|从上到下/);
  assert.match(visionSrc, /不要编造|不要编/);
});

test('视觉模型的输出上限给满（智谱上限 1024，不能再被截断）', () => {
  const m = visionSrc.match(/max_tokens:\s*([^\n]+)/);
  assert.ok(m, '找不到 max_tokens');
  assert.match(m[1], /1024/, '智谱 GLM-4V 上限是 1024，要给到上限');
  // 提示词里的字数上限必须小于 max_tokens 的容量，否则会被硬切断
  const cap = visionSrc.match(/总长度控制在 (\d+) 字以内/);
  assert.ok(cap, '找不到提示词长度上限');
  assert.ok(Number(cap[1]) <= 1000, '提示词上限别超过 1000 字：' + cap[1]);
});

test('桥接优先拿完整图，不拿缩略图', () => {
  assert.match(bridgeSrc, /for _tier in \("full", "best"\)/, '要按 full → best 顺序取图');
  assert.match(bridgeSrc, /tier=_tier/);
  assert.match(bridgeSrc, /图片档位/, '要记日志，方便排查');
});

test('桥接用 BOM 安全的方式读配置（否则 token 读不到，她就不理人）', () => {
  assert.match(bridgeSrc, /utf-8-sig/, 'config.json 带 BOM 时 json.load 会失败');
  assert.match(bridgeSrc, /webhook token/, '启动时要打印 token 状态');
});

test('图片描述长度有上限，不会把上下文塞爆（长截图分段后放宽到 1200）', () => {
  const m = bridgeSrc.match(/if len\(text\) > (\d+):/);
  assert.ok(m, '桥接里没找到长度截断');
  assert.ok(Number(m[1]) >= 600 && Number(m[1]) <= 2000, '截断长度不合理：' + m[1]);
});

/* ---------------- Key 的查找顺序（以前只认 config.vision.apiKey） ---------------- */

const os = require('node:os');
const vision = require('../src/vision');

function makeCfg(settings, visionCfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-vis-'));
  const file = path.join(dir, 'settings.json');
  if (settings) fs.writeFileSync(file, JSON.stringify(settings), 'utf8');
  return {
    config: { vision: visionCfg, paths: { settingsFile: file }, env: {} },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('config.json 里填了 vision.apiKey 就优先用它', () => {
  const { config, cleanup } = makeCfg({ visionApiKey: 'from-settings-key' }, { apiKey: 'from-config-key' });
  assert.equal(vision.resolveKey(config), 'from-config-key');
  cleanup();
});

test('网页「设置」里存的 visionApiKey 能被读到（这正是以前一直提示未配置的原因）', () => {
  const { config, cleanup } = makeCfg({ visionApiKey: 'web-ui-key-123456' });
  assert.equal(vision.resolveKey(config), 'web-ui-key-123456');
  assert.equal(vision.status(config).configured, true);
  cleanup();
});

test('没单独填看图 Key 时，沿用主模型里存过的智谱 Key', () => {
  const { config, cleanup } = makeCfg({ keys: { zhipu: 'zhipu-key-abcdef' } });
  assert.equal(vision.resolveKey(config), 'zhipu-key-abcdef');
  cleanup();
});

test('status() 只给掩码，不回显明文 Key', () => {
  const { config, cleanup } = makeCfg({}, { apiKey: 'secret-key-1234567890' });
  const st = vision.status(config);
  assert.equal(st.configured, true);
  assert.doesNotMatch(st.keyMasked, /1234567890/);
  assert.match(st.keyMasked, /\*\*\*\*/);
  cleanup();
});

test('没 Key 时报错要告诉人去哪儿配，而不是只说「未配置」', async () => {
  const { config, cleanup } = makeCfg({});
  await assert.rejects(
    () => vision.describe(config, { imageBase64: vision.TEST_IMAGE, mime: 'image/png' }),
    (err) => /看图 API Key/.test(err.message) && /bigmodel|智谱/.test(err.message)
  );
  cleanup();
});

test('内置测试图是合法 PNG（「测试看图」要靠它）', () => {
  const buf = Buffer.from(vision.TEST_IMAGE, 'base64');
  assert.equal(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(buf.readUInt32BE(16), 64);
  assert.equal(buf.readUInt32BE(20), 64);
});

/* ---------------- 真实格式 & 微信私有容器（wxgf） ---------------- */

test('微信的 wxgf 图能被认出来，不会再当 jpeg 发出去', () => {
  const wx = Buffer.concat([Buffer.from('wxgf'), Buffer.alloc(200)]);
  assert.equal(vision.sniffMime(wx.toString('base64')), 'image/wxgf');
  assert.equal(vision.sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64')), 'image/jpeg');
});

test('wxgf 直发时立刻给出可操作的报错，不白花一次模型调用', async () => {
  const { config, cleanup } = makeCfg({}, { apiKey: 'k-123456789' });
  await assert.rejects(
    () => vision.describe(config, { imageBase64: Buffer.from('wxgf' + '0'.repeat(200)).toString('base64') }),
    (err) => /wxgf|HEVC/.test(err.message) && /ffmpeg/.test(err.message)
  );
  cleanup();
});

test('智谱的 max_tokens 不超过 1024（超过会被 400 拒掉）', () => {
  const m = visionSrc.match(/max_tokens:\s*([^\n]+)/);
  assert.ok(m, '找不到 max_tokens');
  assert.match(m[1], /1024/, '智谱上限 1024，必须按服务商区分');
  assert.match(visionSrc, /bigmodel/);
});

test('桥接会自己把 ffmpeg 找出来，并处理 wxgf 和长截图', () => {
  assert.match(bridgeSrc, /def ensure_ffmpeg_env/);
  assert.match(bridgeSrc, /_wxgf_to_jpg/, '要真的转码，而不是原样发');
  assert.match(bridgeSrc, /长截图/, '长截图要分段识别');
  assert.match(bridgeSrc, /本机 ffmpeg 没能转出来/, '转不出来要说人话');
});
