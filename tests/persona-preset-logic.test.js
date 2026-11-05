'use strict';

/**
 * 人设预设 / 自定义提示词的纯逻辑回归。
 *
 * 原 tests/persona-preset.test.js 有一半用例在网页人设页（`web/persona.html`）上做断言；
 * 网页控制台在 4.0.2 删除后，那些用例没有对象了。这里保留当时真正在测逻辑的部分：
 *   · personaStore.save 对空字符串的处理（清空自定义提示词必须真的生效）
 *   · 预设导入要记 sourcePreset、标题不能当名字
 *   · 预览接口只读不写
 *   · 恢复默认要清掉自定义提示词
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const personaStore = require('../src/persona/store');
const presets = require('../src/persona/presets');
const { DEFAULT_CONFIG } = require('../src/infra/config');

const root = path.resolve(__dirname, '..');

function freshConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-persona-'));
  return { paths: { dataDir: dir }, persona: {}, chat: {}, links: {}, group: {}, memory: {} };
}

test('清空自定义提示词能真的清掉（不会被空值清理吞掉）', () => {
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

test('导入预设会记下来源，保存接口也接受它', () => {
  // 模块化之后路由在 src/http/routes/persona.js，不再堆在 server.js 里
  const route = fs.readFileSync(path.join(root, 'src', 'http', 'routes', 'persona.js'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'src', 'services', 'persona.js'), 'utf8');
  assert.match(route, /patch\.sourcePreset\s*=\s*preset\.id/, '导入时要记 sourcePreset');
  assert.match(service, /body\.sourcePreset !== undefined/, '保存时接受来源预设');
});

test('预设预览接口：GET 只读不写，返回可填表的内容', () => {
  const route = fs.readFileSync(path.join(root, 'src', 'http', 'routes', 'persona.js'), 'utf8');
  assert.match(route, /router\.get\('\/api\/persona\/preset'/, '要有预览 GET');
  assert.match(route, /presets\.toPatch\(preset\)/, '预览要返回可填表的内容');
});

test('预设标题不能当她的名字；只有 personaName 才能改名', () => {
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

test('HTTP：预览不写盘；导入预设不打乱她的名字和外形', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-preset-name-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false }, watchConfig: false, log: { level: 'error' } }));
  fs.mkdirSync(path.join(tmp, 'assets', 'personas'), { recursive: true });
  for (const name of ['persona-standard.json', 'persona-zhainan.json']) {
    fs.copyFileSync(path.join(root, 'assets', 'personas', name), path.join(tmp, 'assets', 'personas', name));
  }
  const { startServer } = require('../server');
  const inst = await startServer({ root: tmp, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  t.after(() => inst.close());
  const get = async (route) => (await fetch(inst.url + route)).json();
  const before = (await get('/api/persona')).persona;
  const preview = await get('/api/persona/preset?id=persona-standard');
  assert.ok(!('name' in preview.patch), '预览里不能带名字');
  assert.equal((await get('/api/persona')).persona.sourcePreset, before.sourcePreset, '预览不能写盘');
  const applied = await (await fetch(inst.url + '/api/persona/preset', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'persona-standard' }) })).json();
  assert.equal(applied.persona.name, before.name, '导入预设不能把她改名成预设标题');
  assert.equal(applied.persona.appearance, before.appearance, '外形不能丢');
});

test('各版人设预设的差异确实在 customPrompt 上（都写了内容且互不相同）', () => {
  const dir = path.join(root, 'assets', 'personas');
  const seen = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => /^persona-.*\.json$/i.test(n))) {
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
