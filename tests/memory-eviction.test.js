'use strict';

/**
 * 记忆窗口「挤占 / 丢弃」的边界行为（2026-11 分层改造）。
 *
 * 这里不靠魔法预算数字，而是用「达到某条内容所需的最小预算」来排序：
 * 阈值越高 = 越先被丢。钉住任务书 §2.3 的优先级：
 *   低 importance 索引行 → 详情展开 → 中 importance → 高 importance（≥0.8 不丢）；
 * 并且覆盖：长+低重要性、长+高重要性、短条目、单条配额、详情最多 2 条、
 * 检索条数超过窗口上限时的取舍、人物卡整条删除、极限预算不崩。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMemoryBlock } = require('../src/memory/format');
const { estimateBudgetTokens } = require('../src/memory/tokens');
const { LIMITS } = require('../src/memory/constants');
const personCard = require('../src/memory/personCard');
const retrieval = require('../src/memory/retrieval');

const CHAT = 'chat-evict';
/** 结尾声明的前缀（避免把整句抄进断言） */
const MEMORY_NOTICE_PREFIX = '（这些只来自当前这个聊天';

function makeCard() {
  const card = personCard.newCard({ chatId: CHAT, uid: 'u1', name: '小海' });
  personCard.addTrait(card, { text: '嘴硬心软', confidence: 0.9, evidence: ['m1', 'm2'] }, { chatId: CHAT });
  personCard.addPreference(card, { text: '爱吃辣', confidence: 0.9 }, { chatId: CHAT });
  personCard.addThread(card, { text: '周末爬哪座山还没定' }, { chatId: CHAT });
  return card;
}

function blockAt(budget, { card, events, summary = '', caps = null }) {
  return buildMemoryBlock({ card, events, summary, budget, caps });
}

/** 某条内容第一次出现所需的最小预算：越高 = 越先被挤掉 */
function minBudget(needle, ctx, max = 2400) {
  for (let b = 40; b <= max; b += 5) {
    if (blockAt(b, ctx).includes(needle)) return b;
  }
  return null;
}

/** 找一个同时满足条件的预算（用来观察「谁还在、谁已经没了」） */
function findBudget(pred, ctx, max = 2400) {
  for (let b = 40; b <= max; b += 5) {
    const block = blockAt(b, ctx);
    if (pred(block)) return b;
  }
  return null;
}

function indexLines(block, prefix = '- [') {
  return block.split('\n').filter((line) => line.startsWith(prefix));
}

function assertIndexLinesWithin(block, max = 60) {
  const lines = indexLines(block);
  assert.ok(lines.length > 0, '至少要有索引行：' + block);
  for (const line of lines) {
    const len = Array.from(line).length;
    assert.ok(len <= max, `索引行超过 ${max} 字（${len}）：` + line);
  }
}

function expandedSection(block, title) {
  const head = `【展开：${title}】`;
  const start = block.indexOf(head);
  if (start < 0) return null;
  const rest = block.slice(start + head.length);
  const end = rest.indexOf('\n\n');
  return (end < 0 ? rest : rest.slice(0, end)).replace(/^\n/, '');
}

/* ───────────────────────── 1) importance 压过新旧 ───────────────────────── */

test('挤占优先级：低重要（最新）先丢 → 中重要（较旧）→ 高重要（最旧）最后', () => {
  const card = makeCard();
  const low = { date: '2026-11-04', title: '低重要新事', summary: '刚发生的小事，压力有点大', importance: 0.2 };
  const mid = { date: '2026-10-01', title: '中重要旧事', summary: '前段时间的旧事，还没定下来', importance: 0.6 };
  const high = { date: '2026-09-01', title: '高重要长事', summary: '重要的事。' + '啊'.repeat(5000), importance: 0.9 };
  const ctx = { card, events: [low, mid, high] };

  const tLow = minBudget('低重要新事', ctx);
  const tMid = minBudget('中重要旧事', ctx);
  const tHigh = minBudget('高重要长事', ctx);
  assert.ok(tLow > tMid, `低重要应当在预算更宽裕时就消失（${tLow} vs ${tMid}）`);
  assert.ok(tMid > tHigh, `中重要应当比高重要先消失（${tMid} vs ${tHigh}）`);

  // 在「中重要刚好还在」的预算下：最新的低重要已经没了，最旧的高重要还在
  const block = blockAt(tMid, ctx);
  assert.ok(block.includes('中重要旧事'), block);
  assert.ok(!block.includes('低重要新事'), '低重要即使更新也要先丢：' + block);
  assert.ok(block.includes('高重要长事'), '高重要即使更旧也要留：' + block);
});

/* ─────────────────── 2) 低重要索引 vs 详情展开的先后 ─────────────────── */

test('挤占顺序：低 importance 索引行先于详情展开被丢', () => {
  const card = makeCard();
  const low = { date: '2026-11-04', title: '低重要新事', summary: '刚发生的小事', importance: 0.2 };
  const high = { date: '2026-09-01', title: '高重要长事', summary: '重要的事。' + '啊'.repeat(5000), importance: 0.9 };
  const summary = '第一句讲小猫。'.repeat(150); // 用摘要制造预算压力
  const ctx = { card, events: [low, high], summary };

  const tLow = minBudget('低重要新事', ctx);
  const tExpand = minBudget('【展开：', ctx);
  assert.ok(tLow > tExpand, `低重要索引应当先于详情消失（${tLow} vs ${tExpand}）`);

  // 存在一个预算：低重要没了、详情还在（说明详情确实排在它后面）
  const b = findBudget((s) => !s.includes('低重要新事') && s.includes('【展开：') && s.includes('高重要长事'), ctx);
  assert.ok(b != null, '找不到「低重要已丢、详情还在」的预算档');
  assert.ok(estimateBudgetTokens(blockAt(b, ctx)) <= b);
});

/* ─────────────────── 3) 详情展开 vs 中重要索引的先后 ─────────────────── */

test('挤占顺序：详情展开先于中 importance 索引行被丢', () => {
  const card = makeCard();
  const mid = { date: '2026-10-01', title: '中重要旧事', summary: '前段时间的旧事，还没定下来', importance: 0.6 };
  const high = { date: '2026-09-01', title: '高重要长事', summary: '重要的事。' + '啊'.repeat(5000), importance: 0.9 };
  const summary = '第一句讲小猫。'.repeat(120);
  const ctx = { card, events: [mid, high], summary };

  const tExpand = minBudget('【展开：', ctx);
  const tMid = minBudget('中重要旧事', ctx);
  assert.ok(tExpand > tMid, `详情应当先于中重要索引消失（${tExpand} vs ${tMid}）`);

  // 存在一个预算：中重要还在、详情已经没了
  const b = findBudget((s) => s.includes('中重要旧事') && !s.includes('【展开：'), ctx);
  assert.ok(b != null, '找不到「中重要还在、详情已丢」的预算档');
  assert.ok(estimateBudgetTokens(blockAt(b, ctx)) <= b);
});

/* ───────────────── 4) 长 + 低重要 / 长 + 高重要 ───────────────── */

test('长 + 低重要 vs 长 + 高重要：压力下先丢低重要那条', () => {
  const card = makeCard();
  const lowLong = { date: '2026-11-04', title: '低重要长记忆', summary: '换工作的琐事。' + '啊'.repeat(5000), importance: 0.25 };
  const highLong = { date: '2026-08-01', title: '高重要长记忆', summary: '家人住院。' + '啊'.repeat(5000), importance: 0.95, expand: true };
  const ctx = { card, events: [lowLong, highLong] };

  const tLow = minBudget('低重要长记忆', ctx);
  const tHigh = minBudget('高重要长记忆', ctx);
  assert.ok(tLow > tHigh, `低重要长记忆应当先消失（${tLow} vs ${tHigh}）`);

  // 现实预算 900：两条都只占索引行，高重要那条还能展开详情
  const block = blockAt(900, ctx);
  assertIndexLinesWithin(block);
  assert.ok(block.includes('低重要长记忆') && block.includes('高重要长记忆'));
  const detail = expandedSection(block, '高重要长记忆');
  assert.ok(detail != null, '高重要长记忆要展开：' + block);
  assert.ok(Array.from(detail).length <= 200, '详情超 200 字：' + Array.from(detail).length);
  assert.equal(block.includes('【展开：低重要长记忆】'), false, '低重要不该展开');
  // 5000 字不能整段进窗口（详情最多 200 字，索引只取首句）
  assert.ok((block.match(/啊/g) || []).length < 300, '窗口里混进了超长原文：' + block.length);
  assert.ok(estimateBudgetTokens(block) <= 900);
});

test('400 字低重要：只留 ≤60 字索引行，不展开', () => {
  const card = makeCard();
  const long = { date: '2026-11-04', title: '换工作', summary: '最近在换工作，压力挺大。' + '啊'.repeat(400), importance: 0.3 };
  const block = blockAt(900, { card, events: [long] });
  assertIndexLinesWithin(block, 60);
  const line = indexLines(block).find((x) => x.includes('换工作'));
  assert.ok(line, block);
  assert.ok(!line.includes('啊啊'), '索引行不能留填充内容：' + line);
  assert.equal(block.includes('【展开：'), false);
  assert.ok(estimateBudgetTokens(block) <= 900);
});

/* ─────────────── 5) 单条配额 & 详情最多 2 条 ─────────────── */

test('单条配额 25%：预算小到装不下详情时，只留索引不展开', () => {
  const card = makeCard();
  const high = { date: '2026-09-01', title: '高重要长事', summary: '重要的事。' + '细'.repeat(1000), importance: 0.95 };
  const small = blockAt(300, { card, events: [high] });
  assert.equal(small.includes('【展开：'), false, '300 预算下详情配额不够，应只留索引');
  assert.ok(small.includes('高重要长事'));
  assertIndexLinesWithin(small);

  const big = blockAt(900, { card, events: [high] });
  assert.ok(big.includes('【展开：高重要长事】'), '900 预算下应当展开：' + big);
});

test('详情最多展开 2 条，且优先展开 importance 最高的两条', () => {
  const card = makeCard();
  const events = [
    { date: '2026-09-01', title: '要事A', summary: '第A件重要的事，' + '细节'.repeat(30), importance: 0.85 },
    { date: '2026-09-02', title: '要事B', summary: '第B件重要的事，' + '细节'.repeat(30), importance: 0.95 },
    { date: '2026-09-03', title: '要事C', summary: '第C件重要的事，' + '细节'.repeat(30), importance: 0.9 },
  ];
  const block = blockAt(2000, { card, events });
  const count = (block.match(/【展开：/g) || []).length;
  assert.ok(count <= 2, '最多 2 条详情：' + count);
  assert.equal(count, 2, '预算充足时要展开 2 条：' + block);
  assert.ok(block.includes('【展开：要事B】') && block.includes('【展开：要事C】'), '优先展开 importance 最高的两条：' + block);
  assert.equal(block.includes('【展开：要事A】'), false, '第三重要的不该展开');
  for (const ev of events) assert.ok(block.includes(ev.title), '索引行不能少：' + ev.title);
});

/* ─────────────── 6) 检索条数超过窗口上限时的取舍 ─────────────── */

test('超过窗口上限：只收检索排序前 N 条，后面的即使更短也不进窗', () => {
  const card = makeCard();
  // 调用方（retrieval）已经按 score 排好序：这里 1..8 就是排名
  const events = Array.from({ length: 8 }, (_, i) => ({
    date: '2026-09-01',
    title: `事件${i + 1}`,
    summary: `第${i + 1}件事的简述`,
    importance: 0.5,
  }));
  const block = blockAt(100000, { card, events });
  for (let i = 1; i <= LIMITS.retrievalTopK; i += 1) {
    assert.ok(block.includes(`事件${i}`), `前 ${LIMITS.retrievalTopK} 条要在：事件${i}`);
  }
  for (let i = LIMITS.retrievalTopK + 1; i <= 8; i += 1) {
    assert.ok(!block.includes(`事件${i}`), `超过上限的不能进窗：事件${i}`);
  }

  const three = blockAt(100000, { card, events, caps: { events: 3 } });
  assert.ok(three.includes('事件3') && !three.includes('事件4'), 'caps.events=3 时只收前 3');
});

test('检索侧：selectEvents 不超过 topK，并给每条事件打 expand 标记', () => {
  const card = personCard.newCard({ chatId: CHAT, uid: 'u1', name: '小海' });
  for (let i = 1; i <= 8; i += 1) {
    personCard.addEvent(card, {
      date: `2026-10-0${(i % 9) + 1}`,
      title: `检索事件${i}`,
      summary: `第${i}件事的简述，和测试有关`,
      keywords: ['测试'],
      importance: 0.5,
      confidence: 0.8,
    }, { chatId: CHAT });
  }
  const picked = retrieval.selectEvents(card, {
    query: '测试',
    now: Date.parse('2026-11-04T00:00:00'),
    topK: 5,
  });
  assert.ok(picked.length <= 5 && picked.length > 0, 'topK=5：' + picked.length);
  for (const ev of picked) {
    assert.equal(typeof ev.expand, 'boolean', '每条都要有 expand 标记');
    assert.equal(typeof ev._score, 'number');
  }

  const three = retrieval.selectEvents(card, {
    query: '测试',
    now: Date.parse('2026-11-04T00:00:00'),
    topK: 3,
  });
  assert.ok(three.length <= 3, 'topK=3：' + three.length);
});

test('检索到 5 条但窗口只放得下 3 条：按 importance 从低到高丢', () => {
  const card = makeCard();
  const ranks = [0.3, 0.5, 0.7, 0.85, 0.95];
  const events = ranks.map((imp, i) => ({
    date: `2026-09-0${i + 1}`,
    title: `检索第${i + 1}条`,
    summary: `第${i + 1}条事件的简述，稍微长一点点，好让预算有压力`,
    importance: imp,
  }));
  const ctx = { card, events };
  // 「第 3 重要」刚好能进窗的预算：此时最不重要的两条必须已经被挤掉
  const tThird = minBudget('检索第3条', ctx);
  const block = blockAt(tThird, ctx);
  assert.ok(block.includes('检索第3条'), block);
  assert.ok(block.includes('检索第4条') && block.includes('检索第5条'), '高 importance 必须留着：' + block);
  assert.ok(!block.includes('检索第1条'), 'importance 0.3 应最先被丢：' + block);
  assert.ok(!block.includes('检索第2条'), 'importance 0.5 次之：' + block);
  assert.ok(estimateBudgetTokens(block) <= tThird);
  assertIndexLinesWithin(block);
});

/* ─────────────── 7) 人物卡整条丢 & 极限预算 ─────────────── */

test('人物卡：硬裁前先整条删，存活条目都是完整的一条', () => {
  const card = personCard.newCard({ chatId: CHAT, uid: 'u1', name: '小海' });
  for (let i = 0; i < 10; i += 1) {
    personCard.addPreference(card, {
      text: `偏好第${i}条：` + '细节'.repeat(10),
      confidence: 0.9 - i * 0.01,
      key: `k${i}`,
    }, { chatId: CHAT });
  }
  const block = blockAt(150, { card, events: [] });
  const body = block.split(MEMORY_NOTICE_PREFIX)[0];
  const prefsLine = body.split('\n').find((line) => line.startsWith('- 偏好：')) || '';
  const items = prefsLine.replace(/^- 偏好：/, '').split('；').filter(Boolean);
  assert.ok(items.length >= 1 && items.length < 10, `应当删掉一部分而不是全丢/全留：${items.length}`);
  for (const item of items) {
    assert.match(item, /^偏好第\d+条：(?:细节)+$/, '不能切出半条：' + item);
  }
  assert.ok(block.includes('（这些只来自当前这个聊天'), '结尾声明必须在');
  assert.ok(estimateBudgetTokens(block) <= 150, '总额超了：' + estimateBudgetTokens(block));
});

test('极限预算：不抛异常、声明还在、高重要性索引仍可读', () => {
  const card = makeCard();
  const high = { date: '2026-09-01', title: '高重要长事', summary: '重要的事。' + '啊'.repeat(5000), importance: 0.95 };
  for (const budget of [40, 60, 80, 100]) {
    let block;
    assert.doesNotThrow(() => { block = blockAt(budget, { card, events: [high] }); }, 'budget=' + budget);
    assert.equal(typeof block, 'string');
    assert.ok(block.includes('（这些只来自当前这个聊天'), 'budget=' + budget + ' 声明丢了');
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(block), 'budget=' + budget + ' 切出半个代理对');
    assert.equal(Array.from(block).join(''), block);
  }
  // 现实下限（80 token）下，高重要索引行仍是完整的
  const block = blockAt(80, { card, events: [high] });
  assert.ok(block.includes('高重要长事'), '高重要性索引不该被裁没：' + block);
});
