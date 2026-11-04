'use strict';

/**
 * buildMemoryBlock 的分级裁剪语义（BUGS #42）。
 *
 * 以前超预算先整体减半、最后 `block.slice(0, limit)` 硬裁字符串，被切掉的正好是
 * 结尾那句「这些只来自当前这个聊天」和摘要的后半句——声明没了等于允许模型拿别的
 * 聊天的记忆瞎编，摘要切半句模型也读不懂。这里钉住：
 *   1) 正常预算：三段都在、声明单独一段且在最后；
 *   2) 只超一点：只丢最旧事件，摘要和人物卡不动；
 *   3) 超很多：事件清空、摘要变短但仍是整句（不出现半截标点 / 半截 JSON）；
 *   4) 极端小预算：不抛异常、声明仍在、返回值仍是字符串；
 *   5) 空卡 / 无事件 / 无摘要：返回空串；
 *   6) 中文 + emoji + 换行混排：不产生半个字符（代理对不被切开）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMemoryBlock, MEMORY_SCOPE_NOTICE } = require('../src/memory/format');
const { estimateBudgetTokens } = require('../src/memory/tokens');
const personCard = require('../src/memory/personCard');

const CHAT = 'chat-test';

function makeCard() {
  const card = personCard.newCard({ chatId: CHAT, uid: 'user-test', name: '小海' });
  personCard.addTrait(card, { text: '嘴硬心软', confidence: 0.9, evidence: ['m1', 'm2'] }, { chatId: CHAT });
  personCard.addPreference(card, { text: '爱吃辣', confidence: 0.9 }, { chatId: CHAT });
  personCard.addThread(card, { text: '周末爬哪座山还没定' }, { chatId: CHAT });
  return card;
}

function makeEvents(n) {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    out.push({
      date: `2026-10-0${i}`,
      title: `第${i}号事件`,
      summary: `那天聊了很久的第${i}个话题，最后也没聊出结论来`,
      importance: 0.6,
      confidence: 0.8,
    });
  }
  return out;
}

/** 单引号/双引号/emoji 之外还能查「半个代理对」：高位后面没低位，或低位前面没高位 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function summaryOf(block) {
  const start = block.indexOf('【这段之前聊过】\n');
  if (start < 0) return null;
  const rest = block.slice(start + '【这段之前聊过】\n'.length);
  const end = rest.indexOf('\n\n');
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

test('正常预算：三段都在，结尾声明单独一段且在最后', () => {
  const card = makeCard();
  const events = makeEvents(2);
  const summary = '上次说过喜欢猫。还聊到杭州的天气！周末要不要去爬山？';
  const block = buildMemoryBlock({ card, events, summary, budget: 900 });

  const order = ['【这个聊天里的 TA】', '【相关事件·索引】', '【这段之前聊过】', MEMORY_SCOPE_NOTICE]
    .map((h) => block.indexOf(h));
  assert.ok(order.every((idx) => idx >= 0), '四段都要在：' + block);
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], '段顺序不能乱：' + block);
  }
  // 结尾声明是独立一段（前面空行），不是黏在摘要最后一行
  assert.ok(block.trimEnd().endsWith(MEMORY_SCOPE_NOTICE));
  assert.ok(block.includes('\n\n' + MEMORY_SCOPE_NOTICE), '声明要单独成段');
  assert.equal(block.split(MEMORY_SCOPE_NOTICE).length, 2, '声明只出现一次');
  // 正常预算下内容一个都不该少
  assert.ok(block.includes('嘴硬心软'));
  assert.ok(block.includes('爱吃辣'));
  assert.ok(block.includes('第1号事件') && block.includes('第2号事件'));
  assert.equal(summaryOf(block), summary);
  assert.ok(estimateBudgetTokens(block) <= 900, '预算内：' + estimateBudgetTokens(block));
});

test('只超一点：只丢最旧事件，摘要和人物卡不动', () => {
  const card = makeCard();
  const summary = '第一句说猫。第二句说杭州！第三句说爬山？';
  const five = makeEvents(5);

  // 以「丢掉 10-01 那条之后」的块为准算出预算：刚好只够少一条事件
  const fourBlock = buildMemoryBlock({ card, events: five.slice(1), summary, budget: 100000 });
  const budget = estimateBudgetTokens(fourBlock);

  const block = buildMemoryBlock({ card, events: five, summary, budget });

  assert.ok(!block.includes('第1号事件'), '最旧的事件要第一个被丢：' + block);
  for (let i = 2; i <= 5; i += 1) {
    assert.ok(block.includes(`第${i}号事件`), '新事件不能跟着丢：' + block);
  }
  // 摘要、人物卡一条不动
  assert.equal(summaryOf(block), summary, '摘要不该被动');
  assert.ok(block.includes('嘴硬心软') && block.includes('爱吃辣') && block.includes('周末爬哪座山还没定'));
  // 只丢一条，不多丢
  assert.equal((block.match(/第\d号事件/g) || []).length, 4);
  assert.ok(estimateBudgetTokens(block) <= budget);
});

test('超很多：事件清空、摘要变短但仍是完整句子（不切半句 / 半截 JSON）', () => {
  const card = makeCard();
  const events = makeEvents(6);
  const sentences = [
    '第一句讲的是小猫。',
    '第二句讲的是杭州！',
    '{"喜欢":"猫","城市":"杭州"}。',
    '第四句讲的是爬山？',
    '第五句讲的是加班；',
    '第六句讲的是下雨。',
    '第七句讲的是周末。',
    '第八句讲的是收尾。',
  ];
  const summary = sentences.join('');
  // 100 token：事件已经全丢完，摘要还能留前 6 句（再多就超预算）
  const block = buildMemoryBlock({ card, events, summary, budget: 100 });

  assert.ok(!block.includes('【相关事件·索引】'), '超很多时事件应当清空：' + block);
  const kept = summaryOf(block);
  assert.ok(kept != null && kept.length > 0, '摘要不该被整段切没');
  assert.ok(kept.length < summary.length, '摘要应当变短：' + kept);
  // 留下的必须是整句：以句末标点结尾，且不会只留个逗号
  assert.ok(/[。！？；]$/.test(kept), '不能以半句 / 半个标点结尾：' + JSON.stringify(kept));
  assert.ok(!/[，、,]$/.test(kept), '不能停在逗号上：' + JSON.stringify(kept));
  // JSON 只能整条在或整条不在，不能出现半截
  assert.equal(kept.includes('{'), kept.includes('}'), 'JSON 不能只留一半：' + JSON.stringify(kept));
  // 剩下的每一句都必须是原文里的完整句子
  for (const s of sentences) {
    if (kept.includes(s.trim())) continue;
    // 句子被丢掉了没关系；但只要出现句首，就得整句出现
    assert.ok(!kept.includes(s.trim().slice(0, 5)), '不能留半句：' + JSON.stringify(s));
  }
  assert.ok(block.trimEnd().endsWith(MEMORY_SCOPE_NOTICE), '声明永远在最后');
});

test('极端小预算（50 token）：不抛异常、声明仍在、返回值仍是字符串', () => {
  const card = makeCard();
  for (const budget of [50, 20, 0, -1]) {
    let block;
    assert.doesNotThrow(() => {
      block = buildMemoryBlock({ card, events: makeEvents(6), summary: '很长的摘要。'.repeat(30), budget });
    }, '预算 ' + budget + ' 不该抛异常');
    assert.equal(typeof block, 'string');
    assert.ok(block.includes(MEMORY_SCOPE_NOTICE), '极端预算下声明不能被裁掉：' + JSON.stringify(block));
    assert.ok(block.trimEnd().endsWith(MEMORY_SCOPE_NOTICE), '声明仍在最后');
    assert.ok(!LONE_SURROGATE.test(block), '不能切出半个字符');
  }
});

test('空卡 / 无事件 / 无摘要：返回空串，不崩', () => {
  assert.equal(buildMemoryBlock(), '');
  assert.equal(buildMemoryBlock({}), '');
  assert.equal(buildMemoryBlock({ card: personCard.newCard({ chatId: CHAT, uid: 'user-test' }) }), '');
  // 有卡但内容全被删掉 / 没有事件没有摘要，也算空
  const card = personCard.newCard({ chatId: CHAT, uid: 'user-test' });
  card.traits.push({ text: '被删掉的性格', confidence: 0.9, deleted: true });
  card.preferences.push({ text: '被取代的偏好', confidence: 0.9, superseded: true });
  assert.equal(buildMemoryBlock({ card, events: [], summary: '' }), '');
  // 只有一行空白摘要也算空
  assert.equal(buildMemoryBlock({ card, events: [], summary: '   \n\t ' }), '');
});

test('中文 + emoji + 换行混排：不产生半个字符（代理对不被切开）', () => {
  const card = personCard.newCard({ chatId: CHAT, uid: 'user-test' });
  personCard.addTrait(card, {
    text: '😀爱笑也知道心疼人'.repeat(4),
    confidence: 0.9,
    evidence: ['m1', 'm2'],
  }, { chatId: CHAT });
  personCard.addPreference(card, { text: '喜欢🐱和🐶和🐳'.repeat(5), confidence: 0.9 }, { chatId: CHAT });
  const events = [{
    date: '2026-09-01',
    title: '🐳出没',
    summary: '🌊浪很大\n她说：走，去看海！',
    importance: 0.7,
    confidence: 0.8,
  }];
  const summary = '第一句😀。\n第二句🐳！\n第三句🌊？\n第四句🐶。\n第五句🦑；\n第六句收尾。';

  // 覆盖「正常 → 只丢事件 → 丢句 → 减半 → 硬裁」每一档预算
  for (let budget = 0; budget <= 260; budget += 1) {
    const block = buildMemoryBlock({ card, events, summary, budget });
    assert.equal(typeof block, 'string');
    assert.ok(block.includes(MEMORY_SCOPE_NOTICE), 'budget=' + budget + ' 声明丢了：' + JSON.stringify(block));
    assert.ok(!LONE_SURROGATE.test(block), 'budget=' + budget + ' 切出了半个字符：' + JSON.stringify(block));
    assert.ok(!block.includes('\uFFFD'), 'budget=' + budget + ' 出现替换字符');
    // 也不能切出半个字符（每个 emoji 的码点都要在）
    assert.equal(Array.from(block).join(''), block);
  }
});

test('减半只裁人物卡条数：同一张卡小预算下条数变少、内容仍是完整条目', () => {
  const card = personCard.newCard({ chatId: CHAT, uid: 'user-test' });
  for (let i = 0; i < 12; i += 1) {
    personCard.addPreference(card, { text: `偏好第${i}条`, confidence: 0.8, key: `k${i}` }, { chatId: CHAT });
  }
  const full = buildMemoryBlock({ card, events: [], summary: '', budget: 900 });
  const tight = buildMemoryBlock({ card, events: [], summary: '', budget: 60 });
  const fullCount = (full.match(/偏好第\d+条/g) || []).length;
  const tightCount = (tight.match(/偏好第\d+条/g) || []).length;
  assert.ok(tightCount > 0 && tightCount < fullCount, `小预算下展示的条目要更少：${tightCount} / ${fullCount}`);
  // 没有被硬裁成半行：出现的每个偏好都是「偏好第N条」的完整形式
  for (const m of tight.matchAll(/偏好第\d+条(?=；|$|\n)/g)) assert.match(m[0], /^偏好第\d+条$/);
  assert.ok(!/[；：]\s*$/.test(tight.split('\n\n（')[0].split('\n').pop()), '最后一行不能停在分隔符上');
  assert.ok(tight.trimEnd().endsWith(MEMORY_SCOPE_NOTICE));
});
