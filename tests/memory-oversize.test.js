'use strict';

/**
 * 记忆窗口分层：索引行常驻 + 详情按需展开（2026-11）。
 *
 * 以前每条事件渲染 `title 24 + summary 100`，一条 400 字的记忆能占 44% 窗口，
 * 把别人的事挤掉；hardCut 还会把最后一条切成半句。这里钉住：
 *   1) 一条 400 / 5000 字的记忆，窗口里只占 ≤60 字索引行；
 *   2) 总额仍 ≤900 token，其他条目不被挤掉；
 *   3) importance ≥ 0.8 的索引行不被丢；
 *   4) 相关时详情展开 ≤200 字，且不吃掉别人的索引行。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMemoryBlock } = require('../src/memory/format');
const { estimateBudgetTokens } = require('../src/memory/tokens');
const personCard = require('../src/memory/personCard');

const CHAT = 'chat-oversize';

function makeCard() {
  const card = personCard.newCard({ chatId: CHAT, uid: 'u1', name: '小海' });
  personCard.addTrait(card, { text: '嘴硬心软', confidence: 0.9, evidence: ['m1', 'm2'] }, { chatId: CHAT });
  personCard.addPreference(card, { text: '爱吃辣', confidence: 0.9 }, { chatId: CHAT });
  personCard.addThread(card, { text: '周末爬哪座山还没定' }, { chatId: CHAT });
  return card;
}

/** 造一条超长记忆：首句正常，后面全是填充字 */
function hugeEvent(title, fill, extra = {}) {
  return {
    date: '2026-11-03',
    title,
    summary: '最近在换工作，压力挺大，想换个环境。' + '啊'.repeat(fill),
    importance: 0.4,
    confidence: 0.8,
    ...extra,
  };
}

function normalEvents() {
  return [
    { date: '2026-11-02', title: '失眠', summary: '连着几天睡不好', importance: 0.6, confidence: 0.8 },
    { date: '2026-11-01', title: '看展', summary: '周末想去看个展', importance: 0.6, confidence: 0.8 },
    { date: '2026-10-30', title: '猫', summary: '家里的猫又胖了', importance: 0.6, confidence: 0.8 },
  ];
}

/** 索引行：以 "- [" 开头的行 */
function indexLines(block) {
  return block.split('\n').filter((line) => line.startsWith('- ['));
}

function assertIndexLinesWithin(block, max = 60) {
  const lines = indexLines(block);
  assert.ok(lines.length > 0, '至少要有索引行：' + block);
  for (const line of lines) {
    const len = Array.from(line).length;
    assert.ok(len <= max, `索引行超过 ${max} 字（${len}）：` + line);
  }
}

function expandedBlock(block) {
  const start = block.indexOf('【展开：');
  if (start < 0) return null;
  const rest = block.slice(start);
  const end = rest.indexOf('\n\n');
  return end < 0 ? rest : rest.slice(0, end);
}

test('5000 字单条记忆：只占 ≤60 字索引行，总额 ≤900 token，别人不被挤掉', () => {
  const card = makeCard();
  const events = [hugeEvent('换工作', 5000), ...normalEvents()];
  const block = buildMemoryBlock({ card, events, summary: '', budget: 900 });

  assertIndexLinesWithin(block, 60);
  // 索引行里是首句，不是 5000 字全文
  assert.ok(block.includes('换工作'), block);
  assert.ok(!block.includes('啊啊啊啊啊啊啊啊啊啊'), '不能把 5000 字塞进窗口');
  assert.equal(block.includes('【展开：'), false, 'importance 0.4 不该展开详情');
  // 其他条目一条不少
  for (const ev of normalEvents()) assert.ok(block.includes(ev.title), '被挤掉了：' + ev.title);
  // 人物卡也还在
  assert.ok(block.includes('嘴硬心软') && block.includes('爱吃辣') && block.includes('周末爬哪座山还没定'));
  assert.ok(estimateBudgetTokens(block) <= 900, '总额超了：' + estimateBudgetTokens(block));
});

test('400 字单条记忆：同样只留索引行，不挤占别人', () => {
  const card = makeCard();
  const events = [hugeEvent('换工作', 400), ...normalEvents()];
  const block = buildMemoryBlock({ card, events, summary: '', budget: 900 });

  assertIndexLinesWithin(block, 60);
  assert.equal(block.includes('【展开：'), false);
  const line = indexLines(block).find((x) => x.includes('换工作'));
  assert.ok(line, block);
  assert.ok(!line.includes('啊啊啊'), '索引行不能留填充内容：' + line);
  for (const ev of normalEvents()) assert.ok(block.includes(ev.title));
  assert.ok(estimateBudgetTokens(block) <= 900);
});

test('importance ≥ 0.8 的索引行在挤占中不被丢', () => {
  const card = makeCard();
  const important = [
    { date: '2026-11-02', title: '换工作', summary: '决定下周提离职。' + '啊'.repeat(3000), importance: 0.95, confidence: 0.9 },
    { date: '2026-11-01', title: '搬家', summary: '月底要搬到滨江。' + '啊'.repeat(2000), importance: 0.9, confidence: 0.9 },
    { date: '2026-10-31', title: '家人', summary: '妈妈住院了。' + '啊'.repeat(2000), importance: 0.85, confidence: 0.9 },
    { date: '2026-10-30', title: '求职', summary: '在投简历。' + '啊'.repeat(2000), importance: 0.8, confidence: 0.9 },
  ];
  // 预算只够索引行：详情必须被丢掉，但四条索引行都得在
  const block = buildMemoryBlock({ card, events: important, summary: '', budget: 320 });
  assertIndexLinesWithin(block, 60);
  for (const ev of important) assert.ok(block.includes(ev.title), '高 importance 被丢了：' + ev.title);
  assert.equal(block.includes('【展开：'), false, '预算不够时先丢详情');
  assert.ok(estimateBudgetTokens(block) <= 320, '总额超了：' + estimateBudgetTokens(block));
});

test('相关事件才展开详情，且每条 ≤200 字', () => {
  const card = makeCard();
  const related = {
    date: '2026-11-03',
    title: '换工作',
    summary: '最近在换工作，压力挺大，想换个环境。' + '细'.repeat(600),
    importance: 0.6,
    confidence: 0.8,
    expand: true,
  };
  const block = buildMemoryBlock({
    card,
    events: [related, ...normalEvents()],
    summary: '',
    budget: 900,
  });

  const section = expandedBlock(block);
  assert.ok(section, '相关事件应当展开：' + block);
  assert.ok(section.startsWith('【展开：换工作】'), section);
  const detail = section.slice('【展开：换工作】\n'.length);
  assert.ok(Array.from(detail).length <= 200, '详情超 200 字：' + Array.from(detail).length);
  // 索引行仍在（展开是「另起一段」，不是替换索引）
  assertIndexLinesWithin(block, 60);
  assert.ok(indexLines(block).some((x) => x.includes('换工作')));
  // 其他事件不被详情挤掉
  for (const ev of normalEvents()) assert.ok(block.includes(ev.title));
  assert.ok(estimateBudgetTokens(block) <= 900);
});
