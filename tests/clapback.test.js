'use strict';

/**
 * 回怼火力：贴吧老哥档。既要有攻击力，也不能越底线。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const persona = require('../src/persona');
const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

const root = path.resolve(__dirname, '..');
const lines = fs.readFileSync(path.join(root, 'resources', 'clapback.txt'), 'utf8')
  .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));

const cats = new Set(lines.map((s) => s.split('|')[0].trim()));
const texts = lines.map((s) => s.split('|').slice(1).join('|').trim());

test('回怼库有贴吧火力档：重、爹味、反问、典、急了、轻、收尾', () => {
  for (const c of ['重', '爹味', '反问', '典', '急了', '轻', '叫滚', '收尾', '一般']) {
    assert.ok(cats.has(c), '缺少类别：' + c);
  }
  const heavy = lines.filter((s) => /^(重|爹味)\|/.test(s));
  assert.ok(heavy.length >= 45, '重火力台词太少：' + heavy.length);
  assert.ok(lines.length >= 180, '总台词太少：' + lines.length);
});

test('重火力里真的有脏字和爹味，不是软绵绵的礼貌话', () => {
  const heavyText = lines.filter((s) => /^(重|爹味)\|/.test(s)).join('\n');
  assert.match(heavyText, /他妈|妈的|傻逼|孙子|你爹|爹我|乖/, '重火力档应该有脏字或爹味自称');
});

test('守底线：不碰性、不咒家人死、不搞歧视、不威胁线下', () => {
  const banned = [
    /(你|他|她|妈|全家|祖宗)[^，。]{0,4}(死|坟|骨灰|殡|下葬)/, // 冲着人咒死
    /(去死|死全家|死一户口本|快点死)/,
    /强奸|操你妈|艹你妈|日你妈/,     // 性侮辱
    /艾滋|娘炮|人妖|残废|乡下人|外地人|省人/, // 歧视
    /住址|身份证|学校|公司地址|弄死|找人打/, // 人肉/线下威胁
  ];
  for (const t of texts) {
    for (const re of banned) {
      assert.doesNotMatch(t, re, '越线台词：' + t);
    }
  }
});

test('每条台词都是短句，适合微信群聊', () => {
  for (const t of texts) {
    assert.ok(t.length >= 2, '空台词');
    assert.ok(t.length <= 40, '太长（' + t.length + '）：' + t);
  }
});

test('真人模型模式下不再念台词库，交给模型现编', async () => {
  const llm = { isMock: false, model: 'qwen-plus', reload() {}, async complete() { return '行，我记住了'; } };
  const { bot, cleanup } = makeBot({ llm, rng: () => 0 });
  const r = await bot.decide(groupMsg('@鲸鲸 你个废物', { atMe: true }));
  assert.equal(r.action, 'reply');
  assert.notEqual(r.reason, 'clapback', '不该直接念库里的句子');
  assert.match(r.system, /第二条人格：贴吧老哥/);
  assert.match(r.system, /最大档/);
  cleanup();
});

test('没被骂的时候也有这条核心性格，但不会触发开骂', async () => {
  const llm = { isMock: false, model: 'qwen-plus', reload() {}, async complete() { return '嗯' } };
  const { bot, cleanup } = makeBot({ llm });
  const r = await bot.decide(groupMsg('@鲸鲸 今天吃什么', { atMe: true }));
  assert.match(r.system, /核心性格/, '核心性格要常驻');
  assert.doesNotMatch(r.system, /第二条人格/, '没被冒犯时不塞火力档');
  cleanup();
});

test('骂主人 = 开战，而且提示词里加码', async () => {
  const llm = { isMock: false, model: 'qwen-plus', reload() {}, async complete() { return '你算什么东西' } };
  const { bot, cleanup } = makeBot({ llm });
  const r = await bot.decide(groupMsg('@鲸鲸 你主人就是个废物', { atMe: true }));
  assert.equal(r.msg.fight, true);
  assert.equal(r.msg.fightOnMaster, true);
  assert.match(r.system, /往死里骂/);
  cleanup();
});

test('骂废物这种会被判成开战，走最大火力', async () => {
  const llm = { isMock: false, model: 'qwen-plus', reload() {}, async complete() { return '你也配' } };
  const { bot, cleanup } = makeBot({ llm });
  for (const word of ['废物', '垃圾', '菜狗', '蠢货']) {
    const r = await bot.decide(groupMsg('@鲸鲸 你个' + word, { atMe: true }));
    assert.equal(r.msg.fight, true, word + ' 应该触发开战');
    assert.match(r.system, /直接开到最大档/, word + ' 应该给最大火力提示');
  }
  cleanup();
});

test('按对方脏不脏、骂到第几回合选火力档', () => {
  assert.ok(persona.clapbackKinds({ dirty: true }).includes('重'));
  assert.ok(persona.clapbackKinds({ dirty: true }).includes('爹味'));
  assert.ok(persona.clapbackKinds({ dirty: false }).includes('轻'));
  assert.ok(!persona.clapbackKinds({ dirty: false }).includes('重'));
  // 第三回合开始收尾 / 更狠
  assert.ok(persona.clapbackKinds({ dirty: true, round: 3 }).includes('收尾'));
  assert.ok(persona.clapbackKinds({ dirty: false, round: 3 }).includes('收尾'));
  assert.deepEqual(persona.clapbackKinds({ commanded: true }), ['叫滚', '轻']);
});

test('对喷时模型说软话会被换成狠话', async () => {
  const soft = {
    isMock: false, model: 'qwen-plus', reload() {},
    async complete() { return '别生气了，我理解你的感受，我们没必要这样'; },
  };
  const { bot, cleanup } = makeBot({ llm: soft, rng: () => 0.99 });
  const r = await bot.handle(groupMsg('@鲸鲸 你就是个废物', { atMe: true }));
  assert.equal(r.action, 'reply');
  assert.doesNotMatch(r.reply, /别生气|我理解|没必要/, '不该出现软话：' + r.reply);
  assert.ok(texts.includes(r.reply) || /你|爹|爷|急|典|废|骂/.test(r.reply), '应该是库里的硬话：' + r.reply);
  cleanup();
});

test('挨骂时会打两连击（反问/扣帽子 + 补刀）', async () => {
  const { bot, cleanup } = makeBot({ rng: () => 0 });
  const r = await bot.decide(groupMsg('@鲸鲸 你个傻逼', { atMe: true }));
  assert.equal(r.reason, 'clapback');
  assert.ok(r.canned.length > 0);
  // 至少有一次能拼出两段
  let two = 0;
  for (let i = 0; i < 30; i += 1) {
    const one = await bot.decide(groupMsg('@鲸鲸 你个傻逼', { atMe: true, msgId: 'm' + i }));
    if (one.reason === 'clapback' && one.canned.includes('，')) two += 1;
  }
  assert.ok(two > 0, '应该有拼成两连击的回怼');
  cleanup();
});

test('取台词能按多个类别兜底，取不到也返回台词', () => {
  const a = persona.clapbackPick(['重', '爹味']);
  const b = persona.clapbackPick(['不存在', '轻']);
  const c = persona.clapbackPick('完全不存在');
  const all = new Set(texts);
  assert.ok(all.has(a) && all.has(b) && all.has(c));
});

function makeBot({ rng = () => 0, llm } = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'whale-fight-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config, store, logger: null, mockChunkDelayMs: 0, rng,
    llm: llm || { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
  });
  return { bot, config, store, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const groupMsg = (text, extra = {}) => ({
  platform: 'web', chatId: 'g1', chatType: 'group',
  senderId: 'u-x', senderName: '路人', text, chatTitle: '深海鱼塘', ...extra,
});

test('被骂会真的甩出带脏字的回怼，不是温吞的客套话', async () => {
  const { bot, cleanup } = makeBot({ rng: () => 0 });
  const r = await bot.decide(groupMsg('@鲸鲸 你个傻逼废物', { atMe: true }));
  assert.equal(r.action, 'reply');
  assert.equal(r.reason, 'clapback');
  assert.match(r.canned, /傻逼|他妈|妈的|你爹|爹我|孙子|就这|急了/);
  cleanup();
});

test('对喷时提示词里带贴吧火力档和示例', async () => {
  const { bot, cleanup } = makeBot({ rng: () => 0.99 });
  const r = await bot.decide(groupMsg('@鲸鲸 傻逼东西', { atMe: true }));
  assert.equal(r.action, 'reply');
  assert.match(r.system, /贴吧老哥/);
  assert.match(r.system, /急了/);
  assert.match(r.system, /底线/);
  cleanup();
});

test('对喷时模型能看到原话（不被星号洗掉）', async () => {
  const { bot, cleanup } = makeBot({ rng: () => 0.99 });
  const r = await bot.decide(groupMsg('@鲸鲸 你他妈是个傻逼', { atMe: true }));
  const joined = r.turns.map((t) => t.content).join('\n');
  assert.match(joined, /你他妈是个傻逼/);
  cleanup();
});

test('主人被骂不会被回怼（豁免仍然有效）', async () => {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.master = { names: ['Master'], wxids: ['wxid_boss'] };
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'whale-fight2-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config, store, logger: null, mockChunkDelayMs: 0, rng: () => 0,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
  });
  const r = await bot.decide(groupMsg('@鲸鲸 傻逼', { atMe: true, senderId: 'wxid_boss', senderName: 'Master' }));
  assert.notEqual(r.reason, 'clapback');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
