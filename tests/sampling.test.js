'use strict';

/**
 * 「聊久了乱说话」—— 用户截图里的表现：句子开头通顺、越说越离谱、越说越长、
 * 而且几乎不带标点，最后被截断。
 *
 * 根因：frequency_penalty 0.35 + presence_penalty 0.25 会强迫模型避开常用词，
 * 再叠加 temperature 1.15 的高随机性，它就去挑生僻搭配：语法还是中文，语义全散了。
 *
 * 修法：① 默认参数归零惩罚项、温度降到 0.95、max_tokens 给到 700；
 *       ② 老配置自动迁移（只改「恰好等于旧默认值」的）；
 *       ③ 输出侧兜底：识别跑飞/被截断 → 换保守参数重试，还不行就只发第一句。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_CONFIG, LEGACY_SAMPLING, migrateSampling, loadConfig } = require('../src/config');
const { looksDegenerate, cutToSentence, DeepSeekClient } = require('../src/llm');

// 截图里那种「全是字但不成话」的样本
const BAD =
  '认真说这双随机数挺不卖转店号都查快递没做线我拿置谷配个零和让你行收快递时好上紫光这味一上举大你一用会弄头到还要顺你安找不早哦' +
  '而这边半夜能做的就一张干巴巴的眼一睁眼就算觉了再不把打拳摘了没别的就是把大半夜瞪天花板越想越清醒睡不着就别硬躺';

test('默认参数不再逼模型「避开常用词」', () => {
  const ds = DEFAULT_CONFIG.deepseek;
  assert.equal(Number(ds.frequencyPenalty) || 0, 0, 'frequency_penalty 必须归零');
  assert.equal(Number(ds.presencePenalty) || 0, 0, 'presence_penalty 必须归零');
  assert.ok(Number(ds.temperature) <= 1.0, '温度不该超过 1.0，实测 1.15 会跑飞：' + ds.temperature);
  assert.ok(Number(ds.temperature) >= 0.8, '也别太低，否则没「人味」：' + ds.temperature);
  assert.ok(Number(ds.maxTokens) >= 600, '输出预算要够，不然好东西被截断：' + ds.maxTokens);
});

test('config.example.json 和代码默认值一致（新装的用户不该踩坑）', () => {
  const ex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  assert.equal(Number(ex.deepseek.frequencyPenalty) || 0, 0);
  assert.equal(Number(ex.deepseek.presencePenalty) || 0, 0);
  assert.equal(Number(ex.deepseek.temperature), Number(DEFAULT_CONFIG.deepseek.temperature));
  assert.equal(Number(ex.deepseek.maxTokens), Number(DEFAULT_CONFIG.deepseek.maxTokens));
});

test('老配置自动迁移：旧默认值被改掉，用户自己调过的不动', () => {
  // 1) 就是旧默认 → 迁移
  const old = { deepseek: { ...LEGACY_SAMPLING } };
  assert.equal(migrateSampling(old), true, '旧默认值应该被迁移');
  assert.equal(old.deepseek.frequencyPenalty, 0);
  assert.equal(old.deepseek.presencePenalty, 0);
  assert.equal(old.deepseek.temperature, DEFAULT_CONFIG.deepseek.temperature);
  assert.equal(old.deepseek.maxTokens, DEFAULT_CONFIG.deepseek.maxTokens);

  // 2) 用户自己调过温度 → 不动采样参数
  const custom = { deepseek: { ...LEGACY_SAMPLING, temperature: 1.35 } };
  assert.equal(migrateSampling(custom), false, '用户自己调过的不该改');
  assert.equal(custom.deepseek.temperature, 1.35);
  assert.equal(custom.deepseek.frequencyPenalty, 0.35);
});

test('loadConfig 读老 config.json 时就会自动升级', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sampling-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ deepseek: { ...LEGACY_SAMPLING } }), 'utf8');
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(Number(cfg.deepseek.frequencyPenalty) || 0, 0, '读进来就该是 0');
  assert.equal(Number(cfg.deepseek.presencePenalty) || 0, 0);
  assert.equal(Number(cfg.deepseek.temperature), DEFAULT_CONFIG.deepseek.temperature);
});

test('能认出手里这条「全是字但不成话」的跑飞样本', () => {
  assert.equal(looksDegenerate(BAD), true, '截图里那种回复必须被判为跑飞');
  // 正常回复不能误判
  const normal = [
    '累就先瘫着呗。怎么个累法，是身累还是心累？',
    '我叫鲸鲸啊，乐乐是别人瞎起的吧，我不认这个名。',
    '你这话说得挺逗的，那你倒是说说看，你行你上啊？',
    '行行行，你说什么都对。不过说真的，早点睡吧，别熬了。',
  ];
  for (const s of normal) assert.equal(looksDegenerate(s), false, '正常回复不该被误判：' + s);
});

test('撞上长度上限时退到最后一个完整句子', () => {
  const text = '今天天气挺好的呀。要不我们出去走走？我最近一直在家憋着，整个人都要长蘑菇了。然后呢，我还想';
  const cut = cutToSentence(text);
  assert.ok(cut.length < text.length, '要被截短');
  assert.ok(/[。？]$/.test(cut), '要停在完整句子上：' + cut);
});

/** 按真实路径造一个临时配置，再交给 DeepSeekClient（它会自己 resolveRuntime） */
function clientWith(deepseek, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-llm-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ deepseek, provider: 'deepseek' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify(settings), 'utf8');
  return new DeepSeekClient({ config: loadConfig({ root: dir, env: {} }) });
}

test('设置面板里存的旧默认温度也会被归一（1.15 / 1.25 → 0.95）', () => {
  const { resolveRuntime } = require('../src/config');
  for (const legacyTemp of [1.15, 1.25]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-temp-'));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ deepseek: { apiKey: 'sk-test' } }), 'utf8');
    fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify({ temperature: legacyTemp }), 'utf8');
    const rt = resolveRuntime(loadConfig({ root: dir, env: {} }));
    assert.equal(rt.temperature, DEFAULT_CONFIG.deepseek.temperature, `settings 里的 ${legacyTemp} 应被归一`);
  }
  // 用户自己调过的（1.3）必须原样保留
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-temp2-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ deepseek: { apiKey: 'sk-test' } }), 'utf8');
  fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify({ temperature: 1.3 }), 'utf8');
  const rt = resolveRuntime(loadConfig({ root: dir, env: {} }));
  assert.equal(rt.temperature, 1.3, '用户自己调的温度不该被动');
});

test('设置面板滑块的默认值不再是 1.25', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.doesNotMatch(page, /id="temperature"[^>]*value="1\.25"/, '滑块默认值不能还是 1.25');
  assert.match(page, /id="temperature"[^>]*value="0\.95"/, '滑块默认值应是 0.95');
});

test('迁移会写回 config.json（用户打开文件看到的也是新值）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mig-'));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ deepseek: { apiKey: 'sk-keep', ...LEGACY_SAMPLING }, _说明: '别删我' }, null, 2),
    'utf8'
  );
  loadConfig({ root: dir, env: {} });
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(after.deepseek.apiKey, 'sk-keep', '别的字段不能被删');
  assert.equal(after._说明, '别删我', '说明字段要保留');
  assert.equal(Number(after.deepseek.frequencyPenalty), 0);
  assert.equal(Number(after.deepseek.presencePenalty), 0);
  assert.equal(Number(after.deepseek.temperature), DEFAULT_CONFIG.deepseek.temperature);
  assert.equal(Number(after.deepseek.maxTokens), DEFAULT_CONFIG.deepseek.maxTokens);
});

test('settings.json 里的旧默认温度也会被写回 0.95', () => {
  const { resolveRuntime } = require('../src/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-set-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ deepseek: { apiKey: 'sk-test' } }), 'utf8');
  fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify({ temperature: 1.25, provider: 'deepseek' }), 'utf8');
  const rt = resolveRuntime(loadConfig({ root: dir, env: {} }));
  assert.equal(rt.temperature, DEFAULT_CONFIG.deepseek.temperature);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'settings.json'), 'utf8'));
  assert.equal(saved.temperature, DEFAULT_CONFIG.deepseek.temperature, '文件里也要改成新默认');
  assert.equal(saved.provider, 'deepseek', '别的设置不能被删');
});

test('跑飞重试会去掉惩罚项、压低温度', () => {
  // 注意：这些值故意不等于旧默认值，迁移不会动它们
  const client = clientWith({
    apiKey: 'sk-test',
    temperature: 1.3,
    frequencyPenalty: 0.5,
    presencePenalty: 0.4,
    maxTokens: 320,
  });
  const normal = client.buildPayload({ system: 's', turns: [{ role: 'user', content: 'hi' }] });
  assert.equal(normal.frequency_penalty, 0.5, '正常请求保留用户配置');
  assert.equal(normal.presence_penalty, 0.4);
  assert.equal(normal.temperature, 1.3);

  const safe = client.buildPayload({ system: 's', turns: [{ role: 'user', content: 'hi' }], safe: true });
  assert.equal('frequency_penalty' in safe, false, '保守参数不带惩罚项');
  assert.equal('presence_penalty' in safe, false);
  assert.ok(safe.temperature <= 0.7, '保守参数温度要低：' + safe.temperature);
  assert.ok(safe.max_tokens >= 900, '保守参数给足输出预算：' + safe.max_tokens);
});

test('默认配置下惩罚项根本不会发给接口', () => {
  const client = clientWith({ apiKey: 'sk-test' });
  const payload = client.buildPayload({ system: 's', turns: [{ role: 'user', content: 'hi' }] });
  assert.equal('frequency_penalty' in payload, false);
  assert.equal('presence_penalty' in payload, false);
  assert.equal(payload.max_tokens, 700);
  assert.equal(payload.temperature, DEFAULT_CONFIG.deepseek.temperature);
});
