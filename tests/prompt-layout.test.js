'use strict';

/**
 * 提示词「块 + 位置」的回归测试。
 *
 * 背景：DeepSeek 的前缀缓存要求完整匹配一个缓存前缀单元，system 在最前面，
 * 改一个字符后面全部重算。以前 system 里塞了时间、心情、说话人、@名单、字数、梗、
 * 联网资料、动作账本，群里换个人说话 system 就变一次，私聊每分钟也变一次。
 *
 * 这里锁三件事：
 *   1. 同一天内 system 字节稳定（私聊/群聊、换个人说话都不变）；
 *   2. 日期只在 system 里出现一次，每天跟着 now 变；
 *   3. 每轮会变的东西在尾部，时间戳由 ts 确定性推导。
 * 以及回滚开关 features.staticSystem=false 必须和改造前逐字一致（tests/fixtures/prompt-legacy）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const persona = require('../src/persona');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { buildTurns } = require('../src/core/context');
const { assemblePrompt } = require('./support/prompt');

const NOW = new Date(2026, 10, 3, 15, 48, 7); // 2026-11-03 周二（本地时间）

function config(patch = {}) {
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  base.root = path.join(os.tmpdir(), 'whale-prompt-layout');
  base.paths = { ...base.paths, root: base.root, dataDir: path.join(base.root, 'data') };
  const cfg = { ...base, ...patch };
  cfg.persona = { ...base.persona, ...(patch.persona || {}) };
  cfg.chat = { ...base.chat, ...(patch.chat || {}) };
  cfg.features = { ...base.features, ...(patch.features || {}) };
  return cfg;
}

const privateMsg = (extra = {}) => ({
  platform: 'wechat', chatType: 'private', senderName: '小海', text: '在吗', ...extra,
});
const groupMsg = (extra = {}) => ({
  platform: 'wechat', chatType: 'group', senderName: '阿螈', chatTitle: '深海鱼塘', text: '在吗', ...extra,
});

test('同一天内 system 字节稳定：私聊换个人说话、隔一分钟都不变', () => {
  const cfg = config();
  const a = persona.buildSystem({ config: cfg, msg: privateMsg({ senderName: '小海', text: '在吗' }), now: new Date(2026, 10, 3, 10, 0, 0) });
  const b = persona.buildSystem({ config: cfg, msg: privateMsg({ senderName: '阿螈', text: '今天好累啊' }), now: new Date(2026, 10, 3, 10, 1, 0) });
  assert.equal(a, b, '私聊里换个说话人/过一分钟，system 必须一字节都不差');

  const c = persona.buildSystem({ config: cfg, msg: groupMsg({ senderName: '阿螈', text: '在吗' }), now: new Date(2026, 10, 3, 10, 0, 0) });
  const d = persona.buildSystem({ config: cfg, msg: groupMsg({ senderName: '小海', text: '谁在' }), now: new Date(2026, 10, 3, 10, 1, 0) });
  assert.equal(c, d, '群里换个人说话，system 必须一字节都不差');
});

test('system 里只有静态块：心情/说话人/字数/@/联网/链接/对喷/动作账本都在尾部', () => {
  const cfg = config();
  const msg = groupMsg({
    senderName: '阿螈', text: '@鲸鲸 北京天气怎么样',
    groupParticipants: ['阿螈', '小海'], mentionedNames: ['小海'], addressedToBot: true,
    replyToName: '小海', groupStyleText: '这个群平均每句约 12 个字。',
    webText: '【北京 实时天气】现在 10.7°C', linkText: '链接正文：猫猫跳舞',
    discussion: true, fight: true, fightTarget: { name: '小海', text: '你个垃圾' }, fightOnMaster: true,
  });
  const events = [{ ts: NOW.getTime(), type: 'sticker', detail: '开心/wave.gif', status: 'confirmed' }];
  const parts = assemblePrompt({ config: cfg, msg, events, now: NOW });

  for (const leaking of ['语气底子', '本条说话者', '最多约', '当前上下文参与者', '刚联网搜到的资料',
    '对方发的链接', '第二条人格', '最近做过的事', '群平均每句', '学这个群说话']) {
    assert.ok(!parts.system.includes(leaking), `system 里不该出现「${leaking}」：那是每轮会变的内容`);
  }
  for (const expected of ['语气底子', '最多约', '当前上下文参与者', '刚联网搜到的资料', '对方发的链接',
    '第二条人格', '最近做过的事', '学这个群说话']) {
    assert.ok(parts.tail.includes(expected), `尾部应该带上「${expected}」`);
  }
  assert.ok(!parts.system.includes('阿螈'), 'system 里不该出现这条消息的说话人');
  assert.match(parts.prompt, /阿螈/, '拼装后的提示词里当然要有说话人');
});

test('日期行只在 system 里出现一次，跟着 now 走（不写死年份）', () => {
  const cfg = config();
  const sys1 = persona.buildSystem({ config: cfg, msg: privateMsg(), now: new Date(2026, 10, 3, 23, 59, 0) });
  const sys2 = persona.buildSystem({ config: cfg, msg: privateMsg(), now: new Date(2026, 10, 4, 0, 1, 0) });
  const sys3 = persona.buildSystem({ config: cfg, msg: privateMsg(), now: new Date(2031, 4, 6, 12, 0, 0) });

  assert.match(sys1, /今天是 2026年11月3日 周二/);
  assert.match(sys2, /今天是 2026年11月4日 周三/, '跨天时日期行要跟着变（缓存每天失效一次可以接受）');
  assert.notEqual(sys1, sys2);
  assert.match(sys3, /今天是 2031年5月6日 周[日一二三四五六]/);
  assert.doesNotMatch(sys3, /2026年11月/, '提示词里不许写死日期');

  // 整个 system 只有这一行日期，别的时间信息一个都不许出现
  assert.equal(sys1.split('今天是 ').length - 1, 1);
  assert.equal(sys2.split('今天是 ').length - 1, 1);
  // 「几点」交给消息时间戳，system 里不再给时刻
  assert.doesNotMatch(sys1, /15:48|23:59/, 'system 里不该出现具体时刻');
  // 静态规则要告诉模型时间怎么看
  assert.match(sys1, /时间怎么看/);
  assert.match(sys1, /按下面那行「今天是…」回答/);
});

test('历史消息时间戳：首条带、间隔不到 5 分钟不带、≥5 分钟带、跨天带', () => {
  const at = (day, h, m) => new Date(2026, 10, day, h, m, 0).getTime();
  const history = [
    { role: 'user', name: '阿甲', uid: 'a', text: '九点那条', ts: at(3, 9, 0) },
    { role: 'user', name: '阿乙', uid: 'b', text: '一分钟后', ts: at(3, 9, 1) },
    { role: 'user', name: '阿甲', uid: 'a', text: '六分钟后', ts: at(3, 9, 6) },
    { role: 'user', name: '阿乙', uid: 'b', text: '跨天那条', ts: at(4, 0, 10) },
  ];
  const turns = buildTurns({ chatType: 'private', senderName: '小海', text: '现在这条', ts: at(3, 9, 10) }, history, '', '');
  const text = turns.map((t) => t.content).join('\n');

  assert.match(text, /\[11-03 09:00\] 九点那条/, '首条历史要带时间戳');
  assert.doesNotMatch(text, /\[11-03 09:01\]/, '隔 1 分钟不该再打标记（太吵，也省 token）');
  assert.match(text, /\[11-03 09:06\] 六分钟后/, '隔了 5 分钟以上要重新打标记');
  assert.match(text, /\[11-04 00:10\] 跨天那条/, '跨天必须带日期，否则模型不知道过了一天');
  assert.match(text, /\[11-03 09:10\] 现在这条/, '当前这条永远带时间戳');
});

test('同一条消息当「当前」和当「历史」，时间戳字符串完全一致', () => {
  const ts = new Date(2026, 10, 3, 15, 48, 0).getTime();
  const asCurrent = assemblePrompt({ config: config(), msg: { chatType: 'private', senderName: '小海', text: '同一句话', ts }, now: NOW }).prompt;
  const asHistory = assemblePrompt({
    config: config(),
    msg: { chatType: 'private', senderName: '小海', text: '后来的话', ts: ts + 60000 },
    history: [{ role: 'user', text: '同一句话', ts }],
  }).prompt;

  const stamps = (s) => (s.match(/\[\d{2}-\d{2} \d{2}:\d{2}\]/g) || []);
  assert.deepEqual([...new Set(stamps(asCurrent))], ['[11-03 15:48]']);
  assert.ok(stamps(asHistory).includes('[11-03 15:48]'), '当历史时渲染出来的字符串必须一模一样');
});

test('当前消息顺序固定：正文 → 记忆块 → 本轮状态', () => {
  const ts = new Date(2026, 10, 3, 15, 48, 0).getTime();
  const parts = assemblePrompt({
    config: config(),
    msg: { chatType: 'private', senderName: '小海', text: '正文在这里', ts },
    profile: { count: 3 },
    notes: ['怕黑'],
    now: NOW,
  }, { memoryBlock: '【记忆块】她记得的旧事' });

  const last = parts.turns[parts.turns.length - 1].content;
  const body = last.indexOf('正文在这里');
  const memory = last.indexOf('【记忆块】');
  const state = last.indexOf('【本轮状态】');
  assert.ok(body >= 0, '正文要在最后一条 user 消息里');
  assert.ok(memory > body, '记忆块要挂在正文后面');
  assert.ok(state > memory, '本轮状态要挂在记忆块后面');
  assert.equal(parts.tail.startsWith('【本轮状态】'), true);
});

test('features.staticSystem=false：system 与改造前逐字一致（回滚开关）', () => {
  const dir = path.join(__dirname, 'fixtures', 'prompt-legacy');
  const events = [{ ts: new Date(2026, 10, 3, 15, 40, 0).getTime(), type: 'sticker', detail: '开心/wave.gif', status: 'confirmed' }];
  const scenarios = {
    'default-private': {
      config: config({ features: { staticSystem: false } }),
      msg: { platform: 'wechat', chatType: 'private', senderName: '小海', text: '在吗', model: 'deepseek-flash' },
      profile: { count: 4 },
      now: NOW,
    },
    'default-group': {
      config: config({ features: { staticSystem: false } }),
      msg: {
        platform: 'wechat', chatType: 'group', senderName: '阿螈', chatTitle: '深海鱼塘',
        text: '@鲸鲸 帮我看下小海对阿螈说的「你」指谁',
        groupParticipants: ['阿螈', '小海', '旁观者'],
        mentionedNames: ['小海', '阿螈'],
        addressedToBot: true,
        replyToName: '小海',
        groupStyleText: '这个群平均每句约 12 个字，最近常用：yyds、笑死。',
        webText: '【北京 实时天气】\n现在 10.7°C（体感 10.3°C，阴）',
        model: 'deepseek-flash',
        discussion: true,
      },
      events,
      now: NOW,
    },
    'default-private-master-roast': {
      config: config({ persona: { masterRoast: true, ownerName: '爸爸' }, chat: { privateMaxChars: 80 }, features: { staticSystem: false } }),
      msg: { platform: 'wechat', chatType: 'private', senderName: 'Master', isMaster: true, text: '你是不是傻', model: 'deepseek-flash' },
      events,
      now: NOW,
    },
    'custom-private-master': {
      config: config({ persona: { customPrompt: '你是鲸鲸，保持一点俏皮。', masterRoast: true }, features: { staticSystem: false } }),
      msg: { platform: 'wechat', chatType: 'private', senderName: 'Master', isMaster: true, text: '在吗', model: 'deepseek-flash' },
      now: NOW,
    },
  };

  for (const [name, ctx] of Object.entries(scenarios)) {
    const want = fs.readFileSync(path.join(dir, `${name}.txt`), 'utf8');
    assert.equal(persona.buildSystem(ctx), want, `旧行为（${name}）必须逐字一致，回滚才不会翻车`);
  }

  // 旧断言也要在 legacy 模式下跑一遍：时间、场景、语气底子都还在 system 里
  const legacy = scenarios['default-group'];
  const sys = persona.buildSystem(legacy);
  assert.match(sys, /【此刻】现在是2026年11月3日 周二 15:48/);
  assert.match(sys, /【场景】你在微信群「深海鱼塘」里，刚看到「阿螈」说话/);
  assert.match(sys, /语气底子/);
  assert.match(sys, /刚联网搜到的资料/);
  assert.match(sys, /【最近做过的事/, '动作账本在旧行为里也在 system');
});

test('静态模式下 buildTurnState 为空转（旧行为不再拼尾部）', () => {
  const cfg = config({ features: { staticSystem: false } });
  const parts = persona.buildPromptParts({ config: cfg, msg: privateMsg({ text: '在吗' }), now: NOW });
  assert.equal(parts.tail, '');
  assert.match(parts.system, /【此刻】/, '旧行为里时间还在 system');
});
