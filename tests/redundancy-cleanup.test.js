'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StickerService } = require('../src/services/stickerService');
const jsonFile = require('../src/infra/jsonFile');
const { readStoreFile, Store } = require('../src/memory/store');
const { readLegacyStore } = require('../src/memory/migrate');
const persona = require('../src/persona');
const { Bot } = require('../src/pipeline/chat');
const { DEFAULT_CONFIG } = require('../src/infra/config');

const root = path.resolve(__dirname, '..');
const source = rel => fs.readFileSync(path.join(root, rel), 'utf8');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-dedup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  return dir;
}

test('表情包设置只定义一次，每份状态只读取一次且保持响应结构', () => {
  assert.equal((source('src/services/stickerService.js').match(/^  _demandSettings\(\) \{/gm) || []).length, 1);
  let calls = 0;
  const context = {
    config: {}, generation: 3, migration: null,
    maintenance: { phase: 'idle', errors: ['a', 'b', 'c', 'd', 'e', 'f'] },
    _demandSettings() { calls++; return { demandChance: 0.7, ensureSend: false }; },
  };
  const result = StickerService.prototype._statusPayload.call(context, 'test-dir', [], { pending: 2, jobs: [] });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    ok: true, enabled: true, generation: 3, dir: 'test-dir', migration: null, configuredDir: '',
    demandChance: 0.7, ensureSend: false, maintenance: { phase: 'idle', errors: ['a', 'b', 'c', 'd', 'e'] },
    testChat: '文件传输助手', emotions: [], pending: 2, jobs: [],
  });
});

test('表情包频率和必发开关保持原有默认、限幅和字符串兼容', () => {
  for (const [sticker, expected] of [
    [undefined, { demandChance: 0.7, ensureSend: false }],
    [{ demandChance: 0, ensureSend: 'FALSE' }, { demandChance: 0, ensureSend: false }],
    [{ demandChance: 2, ensureSend: 'YES' }, { demandChance: 1, ensureSend: true }],
    [{ demandChance: -1, ensureSend: 1 }, { demandChance: 0, ensureSend: true }],
    [{ demandChance: 'invalid', ensureSend: 'on' }, { demandChance: 0.7, ensureSend: true }],
  ]) {
    assert.deepEqual(StickerService.prototype._demandSettings.call({ config: { sticker } }), expected);
  }
});

test('旧增量日志共用容错读取：保留顺序、跳过半截行，不改写原文件', t => {
  const dir = fixture(t);
  const file = path.join(dir, 'store.json');
  assert.equal(typeof jsonFile.readJournal, 'function');
  assert.deepEqual(jsonFile.readJournal(file), []);
  const raw = '\n {"sessions":{"first":{}}}\r\n\nnot-json\n{"removed":["first"]}\n{"broken":';
  fs.writeFileSync(file + '.journal', raw);
  assert.deepEqual(jsonFile.readJournal(file), [{ sessions: { first: {} } }, { removed: ['first'] }]);
  assert.equal(fs.readFileSync(file + '.journal', 'utf8'), raw);
});

test('快照与迁移读取都复用公共实现，保留各自的合并规则', t => {
  const dir = fixture(t);
  const file = path.join(dir, 'store.json');
  const snap = '\uFEFF' + JSON.stringify({ version: 1, savedAt: 123, stats: { messages: 8 }, digest: ['kept'], sessions: { old: {} } });
  const journal = [
    { sessions: { added: {} } },
    { full: true, sessions: { replacement: {} } },
    { sessions: { final: { title: 'kept' } }, removed: ['replacement'] },
  ].map(x => JSON.stringify(x)).join('\n') + '\n{"half":';
  fs.writeFileSync(file, snap);
  fs.writeFileSync(file + '.journal', journal);
  assert.deepEqual(readStoreFile(file), {
    version: 1, savedAt: 123, stats: { messages: 8, replies: 0 }, digest: ['kept'], sessions: { final: { title: 'kept' } },
  });
  assert.deepEqual(readLegacyStore(file), { final: { title: 'kept' } });
  assert.equal(fs.readFileSync(file, 'utf8'), snap);
  assert.equal(fs.readFileSync(file + '.journal', 'utf8'), journal);
  for (const rel of ['src/memory/store.js', 'src/memory/migrate.js']) {
    assert.match(source(rel), /const \{ readJson, readJournal \} = require\('\.\.\/infra\/jsonFile'\)/);
    assert.doesNotMatch(source(rel), /function read(?:JsonQuiet|Journal)\(/);
  }
});

test('坏快照和 full 空增量仍按旧规则恢复，不把容错合并成新语义', t => {
  const file = path.join(fixture(t), 'store.json');
  fs.writeFileSync(file, '{broken');
  fs.writeFileSync(file + '.journal', '{"sessions":{"old":{}}}\n{"full":true}\n');
  assert.deepEqual(readStoreFile(file).sessions, {});
  assert.deepEqual(readLegacyStore(file), {});
});

test('群聊实际提示词能拿到词库词条，私聊不附加群风格', async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'slang.txt'), '# 注释不算词条\n咕噜咕噜｜测试词条\n小海藻｜另一个词条\n');
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.root = dir;
  config.paths = { dataDir: dir };
  config.features.envContext = false;
  config.websearch.enabled = false;
  config.links.enabled = false;
  config.group.cooldownSec = 0;
  assert.equal(typeof persona.slangTerms, 'function');
  assert.deepEqual(persona.slangTerms(config), ['咕噜咕噜', '小海藻']);
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({ config, store, llm: { isMock: true, model: 'mock' }, logger: null, mockChunkDelayMs: 0 });
  try {
    const msg = { platform: 'web', chatId: 'test-group', chatType: 'group', senderId: 'test-user', senderName: '测试群友', text: '咕噜咕噜' };
    await bot.decide(msg);
    const group = await bot.decide({ ...msg, text: '@鲸鲸 咕噜咕噜', atMe: true });
    assert.equal(group.action, 'reply');
    assert.match(group.tail, /最近常用：咕噜咕噜/);
    const privateReply = await bot.decide({ ...msg, chatId: 'test-private', chatType: 'private', text: '你好' });
    assert.equal(privateReply.action, 'reply');
    assert.doesNotMatch(privateReply.tail, /学这个群说话/);
  } finally {
    store.close();
  }
});

test('启动器只去掉无引用成员，联系人错误摘要复用公共方法', () => {
  const main = source('launcher/MainWindow.xaml.cs');
  assert.doesNotMatch(main, /\b_last\b|\bUptime\(/);
  assert.doesNotMatch(source('launcher/Views/DiagPage.xaml.cs'), /\bLatestRunDir\(/);
  assert.doesNotMatch(source('launcher/Views/SettingsPage.xaml.cs'), /\bBuildSection\(/);
  assert.match(source('launcher/Api.cs'), /public static string Detail\(ApiResult res\)/);
  for (const rel of ['launcher/Views/ContactListEditor.cs', 'launcher/Views/ContactPicker.xaml.cs']) {
    assert.match(source(rel), /Api\.Detail\(res\)/);
    assert.doesNotMatch(source(rel), /private static string Detail\(/);
  }
});

test('主窗口复用启动顺序但保留重启历史，不改变诊断入口默认清零', () => {
  const main = source('launcher/MainWindow.xaml.cs');
  assert.equal((main.match(/await _sup\.StartAllAsync\(clearRestartHistory: false\)/g) || []).length, 2);
  assert.doesNotMatch(main, /_sup\.StartNode\(\)|_sup\.WaitForNodeAsync\(\)|_sup\.StartBridge\(\)/);
  assert.match(source('launcher/RuntimeSupervisor.cs'), /StartAllAsync\(bool clearRestartHistory = true\)/);
  assert.match(source('launcher/RuntimeSupervisor.cs'), /if \(clearRestartHistory\)/);
  assert.match(source('launcher/Views/DiagPage.xaml.cs'), /await _sup\.StartAllAsync\(\)/);
});

test('桥接只删未使用导入，不影响其他模块自己的 subprocess', () => {
  assert.doesNotMatch(source('bridge/engine.py'), /^import subprocess\s*$/m);
  assert.doesNotMatch(source('bridge/uia_boot.py'), /^from typing import .*\bTuple\b/m);
  assert.match(source('bridge/uia_boot.py'), /^import subprocess\s*$/m);
  assert.match(source('bridge/voice_reply.py'), /^import subprocess\s*$/m);
});
