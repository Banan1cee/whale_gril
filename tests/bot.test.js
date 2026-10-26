'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot, extractCommand } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

function makeConfig(overrides = {}) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (overrides.group) Object.assign(cfg.group, overrides.group);
  if (overrides.chat) Object.assign(cfg.chat, overrides.chat);
  if (overrides.memory) Object.assign(cfg.memory, overrides.memory);
  // 测试里固定主人和魔咒，不依赖开源默认值
  cfg.persona.master = { names: ['Master'], wxids: ['wxid_test_master'] };
  cfg.admin = { spell: 'test-spell', minutes: 30, allowAll: false };
  return cfg;
}

function makeBot({ config = makeConfig(), llm, linkReader = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bot-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const mockLlm = llm || { isMock: true, model: 'mock', reload() {}, describe() { return {}; } };
  const bot = new Bot({ config, store, llm: mockLlm, logger: null, mockChunkDelayMs: 0, linkReader });
  return {
    bot,
    store,
    config,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const privateMsg = (text, extra = {}) => ({
  platform: 'web',
  chatId: 's1',
  chatType: 'private',
  senderId: 'u1',
  senderName: '小海',
  text,
  ...extra,
});

const groupMsg = (text, extra = {}) => ({
  platform: 'web',
  chatId: 'g1',
  chatType: 'group',
  senderId: 'u2',
  senderName: '阿螈',
  text,
  chatTitle: '深海鱼塘',
  ...extra,
});

test('私聊一定会回复，并把回复写进记忆', async () => {
  const { bot, store, cleanup } = makeBot();
  const decision = await bot.decide(privateMsg('在吗'));
  assert.equal(decision.action, 'reply');
  assert.equal(decision.mock, true);
  assert.ok(decision.text.length > 0);
  const bubbles = bot.finalize(decision, decision.text);
  assert.ok(Array.isArray(bubbles) && bubbles.length >= 1);
  const msgs = store.messages(decision.key, 10);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].role, 'assistant');
  cleanup();
});

test('群聊里没被叫到就只看不说，但会旁听记住上下文', async () => {
  const { bot, store, cleanup } = makeBot();
  const decision = await bot.decide(groupMsg('今天加班好累'));
  assert.equal(decision.action, 'ignore');
  assert.equal(decision.reason, 'not_addressed');
  assert.equal(store.messages(decision.key, 10).length, 1);
  cleanup();
});

test('@ 或叫名字会触发回复，且回复里不该带 @ 前缀', async () => {
  const { bot, cleanup } = makeBot();
  const a = await bot.decide(groupMsg('@鲸鲸 在吗', { atMe: true }));
  assert.equal(a.action, 'reply');
  assert.ok(!a.msg.cleanText.includes('@'));
  const b = await bot.decide(groupMsg('鲸娘，你觉得呢'));
  assert.equal(b.action, 'reply');
  assert.equal(b.msg.cleanText, '你觉得呢');
  cleanup();
});

test('重复消息 id 会被去重', async () => {
  const { bot, cleanup } = makeBot();
  const first = await bot.decide(privateMsg('你好', { msgId: 'x1' }));
  bot.finalize(first, first.text);
  const second = await bot.decide(privateMsg('你好', { msgId: 'x1' }));
  assert.equal(second.action, 'ignore');
  assert.equal(second.reason, 'duplicate');
  cleanup();
});

test('闭麦 / 开麦 命令生效', async () => {
  const { bot, cleanup } = makeBot();
  const mute = await bot.decide(groupMsg('@鲸鲸 闭麦 1', { atMe: true }));
  assert.equal(mute.action, 'command');
  assert.equal(mute.commandType, 'mute');
  const during = await bot.decide(groupMsg('@鲸鲸 在吗', { atMe: true }));
  assert.equal(during.action, 'ignore');
  assert.equal(during.reason, 'muted');
  const unmute = await bot.decide(groupMsg('@鲸鲸 开麦', { atMe: true }));
  assert.equal(unmute.commandType, 'unmute');
  const after = await bot.decide(groupMsg('@鲸鲸 在吗', { atMe: true }));
  assert.equal(after.action, 'reply');
  cleanup();
});

test('记住 / 查看记忆 / 忘掉', async () => {
  const { bot, store, cleanup } = makeBot();
  const remember = await bot.decide(privateMsg('记住：我怕黑'));
  assert.equal(remember.action, 'command');
  assert.equal(remember.commandType, 'remember');
  const notes = store.listNotes(remember.key);
  assert.equal(notes[0].notes[0], '我怕黑');

  const memory = await bot.decide(privateMsg('你记得我什么'));
  assert.equal(memory.commandType, 'memory');
  assert.match(memory.text, /怕黑/);

  const forget = await bot.decide(privateMsg('忘掉怕黑'));
  assert.equal(forget.commandType, 'forget');
  assert.equal(store.listNotes(forget.key).length, 0);
  cleanup();
});

test('可以改昵称，并写进提示词', async () => {
  const { bot, store, cleanup } = makeBot();
  const res = await bot.decide(privateMsg('叫我小海豚'));
  assert.equal(res.commandType, 'name');
  const decision = await bot.decide(privateMsg('你好呀'));
  assert.match(decision.system, /小海豚/);
  assert.equal(store.profile(decision.key, 'u1').nickname, '小海豚');
  assert.equal(store.displayName(decision.key, 'u1'), '小海豚');
  cleanup();
});

test('群里 @ 她才回应「闭麦」这类自然语言命令；/ 命令随时可用', async () => {
  const { bot, cleanup } = makeBot();
  const natural = await bot.decide(groupMsg('安静'));
  assert.equal(natural.action, 'ignore'); // 没叫她，不理会
  const slash = await bot.decide(groupMsg('/help'));
  assert.equal(slash.action, 'command');
  assert.equal(slash.commandType, 'help');
  cleanup();
});

test('命令识别覆盖常见写法', () => {
  assert.equal(extractCommand('/memory').type, 'memory');
  assert.equal(extractCommand('帮助').type, 'help');
  assert.equal(extractCommand('我叫阿海').type, 'name');
  assert.equal(extractCommand('我叫阿海').arg, '阿海');
  assert.equal(extractCommand('记住：喜欢猫').arg, '喜欢猫');
  assert.equal(extractCommand('闭麦').type, 'mute');
  assert.equal(extractCommand('闭麦 10 分钟').arg, '10');
  assert.equal(extractCommand('今天天气不错'), null);
});

test('只 @ 不说话会给一个可爱的回应', async () => {
  const { bot, cleanup } = makeBot();
  const decision = await bot.decide(groupMsg('@鲸鲸', { atMe: true }));
  assert.equal(decision.action, 'reply');
  assert.ok(decision.canned.length > 0);
  cleanup();
});

test('真实模式下：会组装群聊上下文并调用模型', async () => {
  const captured = {};
  const llm = {
    isMock: false,
    model: 'deepseek-chat',
    reload() {},
    async complete({ system, turns }) {
      captured.system = system;
      captured.turns = turns;
      return '咕噜~ 收到啦，我在的。';
    },
  };
  const { bot, store, cleanup } = makeBot({ llm });
  const first = await bot.decide(groupMsg('今天加班好累'));
  assert.equal(first.action, 'ignore');
  const decision = await bot.decide(groupMsg('@鲸鲸 你说呢', { atMe: true }));
  assert.equal(decision.action, 'reply');
  assert.equal(decision.mock, false);
  const result = await bot.handle(groupMsg('@鲸鲸 那你呢', { atMe: true }));
  assert.equal(result.action, 'reply');
  // reply 现在等于真正发出去的文本（波浪号会被清掉），不再是模型原文
  assert.match(result.reply, /收到啦，我在的/);
  assert.doesNotMatch(result.reply, /~/);
  assert.ok(result.bubbles.join('').includes('收到啦'));
  assert.match(captured.system, /深海鱼塘/);
  const joined = captured.turns.map((t) => t.content).join('\n');
  assert.match(joined, /阿螈/);
  assert.match(joined, /加班好累/);
  const msgs = store.messages(decision.key, 20);
  assert.ok(msgs.some((m) => m.role === 'assistant' && m.text.includes('收到啦')));
  cleanup();
});

test('长回复会被拆成两条气泡（群聊更短）', async () => {
  const longText = '海沟深处其实很安静。只有鲸歌和气泡在慢慢往上飘。你要是累了，就想象自己泡在温水里。';
  const llm = {
    isMock: false,
    model: 'deepseek-chat',
    reload() {},
    async complete() {
      return longText;
    },
  };
  const { bot, cleanup } = makeBot({ llm, config: makeConfig({ chat: { groupMaxChars: 20, privateMaxChars: 20, maxBubbles: 2 } }) });
  const result = await bot.handle(groupMsg('@鲸鲸 讲点深海的', { atMe: true }));
  assert.equal(result.action, 'reply');
  assert.ok(result.bubbles.length >= 1 && result.bubbles.length <= 2);
  assert.ok(result.bubbles.join('').length > 0);
  cleanup();
});

test('冷却时间内的主动接话会被跳过，@ 她可以突破冷却', async () => {
  const config = makeConfig({ group: { freeChat: true, freeChatChance: 1, cooldownSec: 600, requireAt: true } });
  const rng = () => 0; // 概率必中
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bot-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({ config, store, llm: { isMock: true, model: 'mock' }, logger: null, rng, mockChunkDelayMs: 0 });
  const first = await bot.decide(groupMsg('今天天气不错'));
  assert.equal(first.action, 'reply');
  assert.equal(first.reason, 'free_chat');
  bot.finalize(first, first.text);
  const second = await bot.decide(groupMsg('是啊挺暖和的'));
  assert.equal(second.action, 'ignore');
  const addressed = await bot.decide(groupMsg('@鲸鲸 你觉得呢', { atMe: true }));
  assert.equal(addressed.action, 'reply');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('主人在群里不 @ 也会回复（masterAlwaysReply=true），其他人不会', async () => {
  const { bot, cleanup } = makeBot({ config: makeConfig({ group: { masterAlwaysReply: true } }) });
  const master = await bot.decide(groupMsg('今天中午吃啥', { senderName: 'Master', senderId: 'wxid_test_master' }));
  assert.equal(master.action, 'reply');
  assert.equal(master.reason, 'master');

  const other = await bot.decide(groupMsg('今天中午吃啥', { senderName: '路人甲', senderId: 'u999' }));
  assert.equal(other.action, 'ignore');
  cleanup();
});

test('主人私聊会带上主人设定，普通人有关系边界', async () => {
  const { bot, cleanup } = makeBot();
  const m = await bot.decide(privateMsg('我饿了', { senderName: 'Master', senderId: 'wxid_test_master' }));
  assert.equal(m.action, 'reply');
  assert.match(m.system, /【主人】/);
  const o = await bot.decide(privateMsg('我饿了', { senderName: '路人甲', senderId: 'u999' }));
  assert.match(o.system, /关系边界/);
  cleanup();
});

test('消息里有链接时会先读链接，并把内容写进提示词', async () => {
  const linkReader = async (url) => ({ ok: true, url, kind: 'video', title: '猫猫跳舞视频', description: '一只猫在跳舞' });
  const { bot, cleanup } = makeBot({ linkReader });
  const d = await bot.decide(privateMsg('这个视频好好笑 https://v.douyin.com/abc123/ 哈哈哈哈'));
  assert.equal(d.action, 'reply');
  assert.match(d.system, /对方发的链接/);
  assert.match(d.system, /猫猫跳舞视频/);
  cleanup();
});

test('链接读不到时也不会崩', async () => {
  const linkReader = async (url) => ({ ok: false, url, kind: 'web', error: 'timeout' });
  const { bot, cleanup } = makeBot({ linkReader });
  const d = await bot.decide(privateMsg('看这个 https://example.com/x'));
  assert.equal(d.action, 'reply');
  assert.match(d.system, /打不开|对方发的链接/);
  cleanup();
});

test('魔咒：主人输入才生效，其他人输入无效', async () => {
  const { bot, cleanup } = makeBot();
  const denied = await bot.decide(privateMsg('test-spell', { senderName: '路人甲', senderId: 'u999' }));
  assert.equal(denied.action, 'ignore');
  assert.equal(denied.reason, 'not_owner');

  const ok = await bot.decide(privateMsg('test-spell', { senderName: 'Master', senderId: 'wxid_test_master' }));
  assert.equal(ok.action, 'command');
  assert.equal(ok.commandType, 'admin_spell');
  assert.match(ok.text, /管理员权限/);
  assert.ok(bot.store.getState(ok.key).adminUntil > Date.now());
  const texts = bot.store.messages(ok.key, 20).map((m) => m.text).join('|');
  assert.doesNotMatch(texts, /test-spell/, '魔咒不应留在记忆里');
  cleanup();
});

test('管理员命令：状态 / 演示模式 / 主动接话 / 退出管理', async () => {
  const { bot, config, cleanup } = makeBot();
  const master = (text) => privateMsg(text, { senderName: 'Master', senderId: 'wxid_test_master' });
  await bot.decide(master('test-spell'));

  const st1 = await bot.decide(master('状态'));
  assert.equal(st1.action, 'command');
  assert.equal(st1.commandType, 'admin');
  assert.match(st1.text, /管理员在线/);

  const st2 = await bot.decide(master('演示模式 开'));
  assert.match(st2.text, /演示模式已打开/);

  const st3 = await bot.decide(master('群聊主动接话 开'));
  assert.equal(config.group.freeChat, true);
  assert.match(st3.text, /已打开/);

  const st4 = await bot.decide(master('退出管理'));
  assert.match(st4.text, /已关闭/);
  assert.equal(bot.store.getState(st4.key).adminUntil, 0);

  // 主人永远有管理员权限，退出管理只是清掉计时器
  const normal = await bot.decide(master('状态'));
  assert.equal(normal.commandType, 'admin');
  assert.equal(bot.store.getState(normal.key).adminUntil, 0);
  const chat = await bot.decide(master('在干嘛呢'));
  assert.equal(chat.action, 'reply');
  cleanup();
});

test('管理员权限过期会失效，非主人不能用管理命令', async () => {
  const { bot, cleanup } = makeBot();
  const master = (text) => privateMsg(text, { senderName: 'Master', senderId: 'wxid_test_master' });
  const ok = await bot.decide(master('test-spell'));

  // 同一个聊天里，别人发「状态」不会拿到管理员回复
  const other = await bot.decide(privateMsg('状态', { senderName: '路人甲', senderId: 'u999' }));
  assert.notEqual(other.commandType, 'admin');

  // 主人不受计时器影响：过期了照样是管理员
  bot.store.getState(ok.key).adminUntil = Date.now() - 1000;
  const expired = await bot.decide(master('状态'));
  assert.equal(expired.commandType, 'admin');
  cleanup();
});

test('管理员可以随时调语态 / 长度 / 能力，并写进提示词', async () => {
  const { bot, config, cleanup } = makeBot();
  const master = (text) => privateMsg(text, { senderName: 'Master', senderId: 'wxid_test_master' });
  await bot.decide(master('test-spell'));

  const tone = await bot.decide(master('语气 高冷'));
  assert.match(tone.text, /高冷/);
  assert.equal(config.persona.stylePreset, '高冷');

  const style = await bot.decide(master('语态 回复别超过一句，别用省略号'));
  assert.match(style.text, /记下了/);
  assert.equal(config.persona.styleText, '回复别超过一句，别用省略号');

  const len = await bot.decide(master('长度 群聊 30'));
  assert.equal(config.chat.groupMaxChars, 30);

  const emoji = await bot.decide(master('颜文字 关'));
  assert.equal(config.persona.emojiLevel, '关');

  const ab = await bot.decide(master('能力 链接 关'));
  assert.equal(config.links.enabled, false);
  const ab2 = await bot.decide(master('能力 主动接话 开'));
  assert.equal(config.group.freeChat, true);

  // 下一句普通聊天，提示词里应带上刚定的人设
  const next = await bot.decide(master('在干嘛'));
  assert.match(next.system, /主人给你定的说话方式/);
  assert.match(next.system, /高冷/);
  assert.match(next.system, /回复别超过一句/);

  // 恢复默认
  const reset = await bot.decide(master('恢复默认'));
  assert.match(reset.text, /默认/);
  assert.equal(config.persona.stylePreset, '');
  assert.equal(config.chat.groupMaxChars, 70);
  assert.equal(config.links.enabled, true);
  cleanup();
});

test('主人的语态命令直接生效（不用先开魔咒）', async () => {
  const { bot, config, cleanup } = makeBot();
  // 主人的话无条件执行：不需要魔咒
  const r = await bot.decide(privateMsg('语态 说脏话', { senderName: 'Master', senderId: 'wxid_test_master' }));
  assert.equal(r.action, 'command');
  assert.equal(config.persona.styleText, '说脏话');

  // 但普通人发同样的命令不生效
  const other = await bot.decide(privateMsg('语态 说脏话', { senderName: '路人甲', senderId: 'u999' }));
  assert.notEqual(other.commandType, 'admin');
  cleanup();
});

test('管理员可以按群名禁言，禁言后那个群完全不说话', async () => {
  const { bot, config, cleanup } = makeBot();
  const master = (text) => privateMsg(text, { senderName: 'Master', senderId: 'wxid_test_master' });
  await bot.decide(master('test-spell'));

  const r = await bot.decide(master('别在鼠标群说话'));
  assert.match(r.text, /鼠标/);
  assert.deepEqual(config.group.mutedGroups, ['鼠标']);

  const g = await bot.decide(groupMsg('今天聊啥', { chatTitle: '鼠标' }));
  assert.equal(g.action, 'ignore');
  assert.equal(g.reason, 'muted_group');

  const g2 = await bot.decide(groupMsg('@鲸鲸 在吗', { chatTitle: '别的群' }));
  assert.equal(g2.action, 'reply');

  const u = await bot.decide(master('解除禁言 鼠标'));
  assert.equal(config.group.mutedGroups.length, 0);
  cleanup();
});

test('主人说禁言直接生效，不用先开魔咒', async () => {
  const { bot, config, cleanup } = makeBot();
  const r = await bot.decide(privateMsg('别在鼠标群说话', { senderName: 'Master', senderId: 'wxid_test_master' }));
  assert.equal(r.action, 'command');
  assert.deepEqual(config.group.mutedGroups, ['鼠标']);

  // 普通人说同样的话：不执行，也不改配置
  const other = await bot.decide(privateMsg('别在键盘群说话', { senderName: '路人甲', senderId: 'u999' }));
  assert.notEqual(other.commandType, 'admin');
  assert.deepEqual(config.group.mutedGroups, ['鼠标']);
  cleanup();
});

test('讨论类问题会标记为 discussion，普通闲聊不会', async () => {
  const { bot, cleanup } = makeBot();
  const d1 = await bot.decide(privateMsg('你觉得人应该追求稳定还是冒险'));
  assert.equal(d1.msg.discussion, true);
  // 换个聊天对象：讨论模式的 10 分钟粘性只作用于原会话
  const d2 = await bot.decide(privateMsg('在吗', { chatId: 's2' }));
  assert.equal(d2.msg.discussion, false);
  cleanup();
});

test('管理员能调上下文长度和人味（情绪/主动/观点）', async () => {
  const { bot, config, cleanup } = makeBot();
  const master = (text) => privateMsg(text, { senderName: 'Master', senderId: 'wxid_test_master' });
  await bot.decide(master('test-spell'));

  const r1 = await bot.decide(master('上下文 20'));
  assert.match(r1.text, /20/);
  assert.equal(config.chat.historyTurns, 20);

  const r2 = await bot.decide(master('人味 低'));
  assert.match(r2.text, /低/);
  assert.equal(config.persona.emotions, false);
  assert.equal(config.persona.proactive, false);
  assert.equal(config.persona.opinions, false);

  const next = await bot.decide(master('在吗'));
  assert.match(next.system, /别明显表露情绪/);

  const r3 = await bot.decide(master('人味 高'));
  assert.equal(config.persona.emotions, true);
  assert.equal(config.persona.proactive, true);
  cleanup();
});

test('普通人把昵称改成主人名也不能提权', async () => {
  const { bot, cleanup } = makeBot();
  const stranger = (text) => privateMsg(text, { senderName: '路人甲', senderId: 'u999' });
  const renamed = await bot.decide(stranger('叫我 Master'));
  assert.equal(renamed.commandType, 'name');
  const spell = await bot.decide(stranger('test-spell'));
  assert.equal(spell.action, 'ignore');
  assert.equal(spell.reason, 'not_owner');
  cleanup();
});

test('主人骂她也不会进入回怼库', async () => {
  const { bot, cleanup } = makeBot();
  const result = await bot.handle(groupMsg('@鲸鲸 傻逼', {
    atMe: true,
    senderName: 'Master',
    senderId: 'wxid_test_master',
  }));
  assert.equal(result.action, 'reply');
  assert.notEqual(result.reason, 'clapback');
  cleanup();
});

test('接话窗口只跟同一个人，不抢别人聊天', async () => {
  const { bot, cleanup } = makeBot();
  await bot.decide(groupMsg('@鲸鲸', { atMe: true, senderName: '甲', senderId: 'u-a' }));
  const same = await bot.decide(groupMsg('为什么不行', { senderName: '甲', senderId: 'u-a' }));
  assert.equal(same.action, 'reply');
  const other = await bot.decide(groupMsg('你吃饭了吗', { senderName: '乙', senderId: 'u-b' }));
  assert.equal(other.action, 'ignore');
  assert.equal(other.reason, 'engaged_side_chatter');
  cleanup();
});

test('同名群友单独 @ 时只恢复自己的上一条问题', async () => {
  const { bot, cleanup } = makeBot();
  await bot.decide(groupMsg('甲的问题是什么', { senderName: '同名', senderId: 'u-a' }));
  await bot.decide(groupMsg('乙的问题是什么', { senderName: '同名', senderId: 'u-b' }));
  const recovered = await bot.decide(groupMsg('@鲸鲸', { atMe: true, senderName: '同名', senderId: 'u-a' }));
  assert.equal(recovered.msg.cleanText, '甲的问题是什么');
  cleanup();
});
