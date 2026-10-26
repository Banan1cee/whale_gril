'use strict';

/**
 * 「三个人格预设没用，每次调完还是没区别」——三处叠加的 bug：
 *
 *   1. web/persona.html 的 save() 根本没把 customPrompt 发出去 →
 *      在「自定义提示词」里写什么，点保存都被静默丢弃；
 *   2. 同一个页面的 fill() 也没回填 customPrompt →
 *      导入 v1/v2/v3 之后框里还是空的，用户看不出预设到底生效没有；
 *      而 v1/v2/v3 的差异**只**在 customPrompt 里（preset 都是「正常」、text 基本相同）。
 *   3. personaStore.save() 会把空字符串统一删掉，于是 apply() 读不到这个键 →
 *      自定义提示词一旦写入就永远清不掉，之后改性格/外貌/整体语气全部无效。
 *      这才是「调完还是没区别」的主因。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const personaStore = require('../src/personaStore');

const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'web', 'persona.html'), 'utf8');

function freshConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-persona-'));
  return { paths: { dataDir: dir }, persona: {}, chat: {}, links: {}, group: {}, memory: {} };
}

test('页面保存时会把「自定义提示词」发出去', () => {
  const body = page.slice(page.indexOf('async function save()'));
  const fn = body.slice(0, body.indexOf('async function load') > 0 ? body.indexOf('async function load') : 4000);
  assert.match(fn, /customPrompt:\s*\$\('customPrompt'\)\.value/, 'save() 必须带 customPrompt，否则写了等于没写');
});

test('页面加载/导入后会把「自定义提示词」回填进输入框', () => {
  const body = page.slice(page.indexOf('function fill('));
  const fn = body.slice(0, body.indexOf('function updateCustomNotice'));
  assert.match(fn, /\$\('customPrompt'\)\.value\s*=\s*p\.customPrompt/, 'fill() 必须回填，否则看不出预设生效没有');
});

test('自定义提示词生效时页面要明确提示「下面那些控件不生效」', () => {
  assert.match(page, /id="customNotice"/, '要有提示位置');
  assert.match(page, /自定义提示词生效中/, '要写清楚现在是谁在生效');
  assert.match(page, /都不会被使用/, '要说明性格/外貌/语气被忽略');
  assert.match(page, /id="clearCustom"/, '要有一个「清空自定义提示词」的出口');
});

test('清空自定义提示词能真的清掉（不会再被空值清理吞掉）', () => {
  const cfg = freshConfig();
  personaStore.save(cfg, { customPrompt: 'AAAA' });
  assert.equal(cfg.persona.customPrompt, 'AAAA');
  personaStore.save(cfg, { customPrompt: '' });
  assert.equal(cfg.persona.customPrompt, '', '空字符串必须让 apply() 看到，才能清空');
  // 落盘时不该留空串
  const file = JSON.parse(fs.readFileSync(path.join(cfg.paths.dataDir, 'persona.json'), 'utf8'));
  assert.ok(!('customPrompt' in file) || file.customPrompt !== '', '文件里别留空字符串');
});

test('清空后能改回用控件（性格/语气重新生效）', () => {
  const cfg = freshConfig();
  personaStore.save(cfg, { customPrompt: 'AAAA', personality: '很凶' });
  personaStore.save(cfg, { customPrompt: '' });
  assert.equal(cfg.persona.customPrompt, '');
  assert.equal(cfg.persona.personality, '很凶', '清空自定义提示词不该动别的字段');
});

test('导入预设会记下来源，页面能显示「当前生效是哪版」', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /patch\.sourcePreset\s*=\s*preset\.id/, '导入时要记 sourcePreset');
  assert.match(page, /function showSourcePreset/, '页面要能显示来源');
  assert.match(page, /当前生效/, '要有「当前生效」这行字');
});

test('三个人设预设的差异确实在 customPrompt 上（都写了内容且互不相同）', () => {
  const dir = path.join(root, 'personas');
  const seen = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => /^persona-v\d+\.json$/i.test(n))) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''));
    const cp = String(data.customPrompt || '');
    assert.ok(cp.length > 200, f + ' 的 customPrompt 太短，等于没有');
    seen.set(f, cp);
  }
  assert.ok(seen.size >= 3, '至少要有三版预设');
  const texts = [...seen.values()];
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      assert.notEqual(texts[i], texts[j], '两版预设的 customPrompt 不能一模一样');
    }
  }
});

/**
 * 「恢复默认」也得能清掉自定义提示词。
 * 3.3.5 的 DEFAULTS 里没有 customPrompt / sourcePreset，
 * 于是 clear() → apply(DEFAULTS) 看不到这两个键，旧提示词继续盖在控件人设上面，
 * 用户点「恢复默认」还是没变化。默认人格必须是「正常人格」。
 */
test('恢复默认会清掉自定义提示词，回到正常人格', () => {
  const { DEFAULT_CONFIG } = require('../src/config');
  // 出厂配置本身不该带自定义提示词
  assert.equal(String(DEFAULT_CONFIG.persona.customPrompt || ''), '', '出厂不该预设自定义提示词');
  assert.equal(String(DEFAULT_CONFIG.persona.stylePreset || ''), '', '出厂不该预设整体语气');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-reset-'));
  const cfg = { paths: { dataDir: dir }, persona: {}, chat: {}, links: {}, group: {}, memory: {} };
  personaStore.save(cfg, { customPrompt: 'AAAA', sourcePreset: 'persona-v3', personality: '很凶' });
  personaStore.clear(cfg);
  assert.equal(cfg.persona.customPrompt, '', '恢复默认必须清掉自定义提示词');
  assert.equal(cfg.persona.sourcePreset, '', '恢复默认要清掉预设来源');
  assert.match(cfg.persona.personality, /温柔/, '性格要回到出厂设定');
});

test('人设页把「默认」标成「正常」，避免以为默认是别的人格', () => {
  assert.match(page, /<option value="">正常（默认）<\/option>/, '默认档要写明是正常人格');
});