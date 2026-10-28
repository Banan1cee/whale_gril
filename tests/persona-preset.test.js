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
  // 保存用 readForm() 拼 payload；customPrompt 必须在里面
  const body = page.slice(page.indexOf('function readForm()'));
  const fn = body.slice(0, body.indexOf('async function save()'));
  assert.match(fn, /customPrompt:\s*\$\('customPrompt'\)\.value/, '保存必须带 customPrompt，否则写了等于没写');
  assert.match(page.slice(page.indexOf('async function save()')), /\.\.\.readForm\(\)/, 'save() 要用 readForm()');
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

test('人设页：选到哪版就直接填进下面输入框，不需要先点「导入」，保存才生效', () => {
  assert.match(page, /async function previewPreset/, '要有预览函数');
  assert.match(page, /\$\('presetPick'\)\.addEventListener\('change'/, '换预设要立刻预览');
  assert.match(page, /loadPresetsAndPreview\(\)/, '打开页面就要自动载入一版');
  assert.match(page, /sourcePreset:\s*PREVIEW_PRESET/, '保存时要记下这一版来自哪个预设');
  assert.doesNotMatch(page, /id="presetApply"/, '「导入」按钮要删掉');
  assert.doesNotMatch(page, /导入这个预设会覆盖/, '不再有导入确认弹窗');
});

test('人设页预览接口：GET 只读不写，返回内容给输入框', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /pathname === '\/api\/persona\/preset' && method === 'GET'/, '要有预览 GET');
  assert.match(server, /presets\.toPatch\(preset\)/, '预览要返回可填表的内容');
  assert.match(server, /body\.sourcePreset !== undefined/, '保存时接受来源预设');
});

test('预设标题不能当她的名字；只有 personaName 才能改名', () => {
  const presets = require('../src/presets');
  const cfg = { paths: { root } };
  for (const item of presets.list(cfg)) {
    const one = presets.load(cfg, item.id);
    const patch = presets.toPatch(one);
    assert.ok(one.name, item.id + ' 预设本身有标题');
    assert.ok(!('name' in patch), item.id + ' 的标题不能写进 persona.name');
  }
  const patch = presets.toPatch({ name: '别拿标题当名字', personaName: '真正的名字' });
  assert.equal(patch.name, '真正的名字');
});

test('预览只覆盖预设里有的字段，不会清空外形/性格/背景', () => {
  const body = page.slice(page.indexOf('function applyPresetToForm'));
  const fn = body.slice(0, body.indexOf('async function previewPreset'));
  assert.match(fn, /readForm\(\)/, '要拿当前表单的值做底');
  assert.match(fn, /\.\.\.patch/, '再把预设字段盖上去');
  assert.match(page, /function readForm\(\)/, '保存和预览共用同一份读表单逻辑');
});

test('HTTP：预览不写盘；导入预设不打乱她的名字和外形', async (t) => {
  const os2 = require('node:os');
  const fs2 = require('node:fs');
  const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'whale-preset-name-'));
  fs2.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false }, watchConfig: false, log: { level: 'error' } }));
  fs2.mkdirSync(path.join(tmp, 'personas'), { recursive: true });
  for (const name of ['persona-v1.json', 'persona-v2.json']) {
    fs2.copyFileSync(path.join(root, 'personas', name), path.join(tmp, 'personas', name));
  }
  const { startServer } = require('../server');
  const inst = await startServer({ root: tmp, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  t.after(() => inst.close());
  const get = async (route) => (await fetch(inst.url + route)).json();
  const before = (await get('/api/persona')).persona;
  const preview = await get('/api/persona/preset?id=persona-v1');
  assert.ok(!('name' in preview.patch), '预览里不能带名字');
  assert.equal((await get('/api/persona')).persona.sourcePreset, before.sourcePreset, '预览不能写盘');
  const applied = await (await fetch(inst.url + '/api/persona/preset', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'persona-v1' }) })).json();
  assert.equal(applied.persona.name, before.name, '导入预设不能把她改名成预设标题');
  assert.equal(applied.persona.appearance, before.appearance, '外形不能丢');
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