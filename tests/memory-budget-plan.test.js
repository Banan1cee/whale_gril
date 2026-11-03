'use strict';

/**
 * 预算分片（budgetPlan）：调一个数（dialogueBudget），所有分片按比例重算。
 *
 * 核心断言：
 *   1. 默认 5,500 必须 1:1 复刻旧分片（recent 3200 / memory 900 / summary 900 / reserve 500），
 *      老行为不能变；
 *   2. 任何预算下 sum(分片) === dialogueBudget（不漏不溢）；
 *   3. 调大预算 → recent 涨、memory/summary/reserve 被结构上限夹住；
 *   4. 关系卡开/关只影响 recent 与 relations，不偷别人的份额；
 *   5. 压缩阈值随 recent 派生（否则预算调大后仍按 3,200 压缩，等于白调）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LIMITS } = require('../src/memory/constants');
const { planBudget, SHARES, CEILINGS, TIERS, nearestTier } = require('../src/memory/budgetPlan');
const budget = require('../src/memory/budget');
const { Store } = require('../src/memory/store');
const { estimateTokens, estimateBudgetTokens } = require('../src/memory/tokens');
const { buildMemoryBlock } = require('../src/memory/format');
const personCard = require('../src/memory/personCard');

function makeStore(dir, limits = {}) {
  return new Store({ file: path.join(dir, 'data', 'store.json'), logger: null, limits });
}

function seed(store, key, count, chars = 80) {
  const chat = store.chatStore.ensureChat(key, { platform: 'wechat', chatType: 'group' });
  for (let i = 0; i < count; i += 1) {
    const text = '第' + i + '句话' + '啊'.repeat(chars);
    chat.messages.push({
      seq: i + 1,
      role: 'user',
      name: '小海',
      text,
      ts: Date.now() + i,
      tokens: estimateTokens(text) + 4,
    });
  }
  chat.meta.nextSeq = count + 1;
  return chat;
}

test('默认 5,500：1:1 复刻旧分片，老行为不变', () => {
  const p = planBudget(LIMITS.dialogueBudget);
  assert.equal(p.dialogueBudget, 5500);
  assert.equal(p.recent, 3200);
  assert.equal(p.memory, LIMITS.memoryTokens);
  assert.equal(p.summary, LIMITS.summaryTokens);
  assert.equal(p.reserve, LIMITS.reserveTokens);
  assert.equal(p.relations, 0);
  assert.equal(p.total, 5500);
  assert.equal(p.ok, true);
  // 压缩阈值也必须是旧的 2,400 / 2,400 / 800
  assert.equal(p.recentSoft, LIMITS.softTriggerTokens);
  assert.equal(p.recentLow, LIMITS.recentLowTokens);
  assert.equal(p.compressChunk, LIMITS.compressChunkTokens);
  // 条数上限也必须是旧的 120 / 100
  assert.equal(p.recentCount, LIMITS.recentMessages);
  assert.equal(p.groupRecentCount, LIMITS.groupRecentMessages);
});

test('条数上限跟着 recent 走，并有硬上限', () => {
  const a = planBudget(5500);
  const c = planBudget(20000);
  assert.ok(c.recentCount > a.recentCount);
  assert.ok(c.groupRecentCount > a.groupRecentCount);
  assert.ok(c.recentCount <= 1500 && c.groupRecentCount <= 1200, '条数要有天花板');
  assert.ok(planBudget(1000).recentCount >= 20, '小预算最少也给 20 条');
});

test('任何预算下 sum(分片) === dialogueBudget', () => {
  for (const D of [1000, 1200, 1500, 2000, 2700, 3000, 3300, 4200, 5000, 5500, 6500, 8000, 12000, 20000, 40000]) {
    const p = planBudget(D);
    assert.equal(p.total, D, 'D=' + D);
    assert.equal(p.recent + p.memory + p.summary + p.reserve + p.relations, D, 'D=' + D);
    assert.ok(p.recent > 0, 'recent 必须为正：D=' + D);
    for (const k of ['memory', 'summary', 'reserve', 'relations']) {
      assert.ok(p[k] >= 0, `${k} 不能为负：D=${D}`);
    }
  }
});

test('调大预算：记忆/摘要先按比例涨，到结构上限后全给 recent', () => {
  const a = planBudget(5500);
  const b = planBudget(8000);
  const c = planBudget(20000);
  // 8,000：16.36% 还没到上限，记忆和摘要跟着涨
  assert.ok(b.memory > a.memory, '8000 的 memory 要大于 5500');
  assert.ok(b.summary > a.summary, '8000 的 summary 要大于 5500');
  assert.equal(b.memory, Math.round(SHARES.memory * 8000));
  // 20,000：都顶到结构上限，不再涨
  assert.equal(c.memory, CEILINGS.memory);
  assert.equal(c.summary, CEILINGS.summary);
  assert.equal(c.reserve, CEILINGS.reserve);
  // recent 一路涨，并且吃下所有到顶后剩下的预算
  assert.ok(b.recent > a.recent && c.recent > b.recent);
  assert.equal(c.recent, 20000 - CEILINGS.memory - CEILINGS.summary - CEILINGS.reserve);
  assert.ok(c.recent > 8000);
});

test('人物卡显示条数跟着 memory 预算涨（只加 token 不加条数等于没用）', () => {
  const small = planBudget(5500).caps;
  const mid = planBudget(8000).caps;
  const big = planBudget(20000).caps;
  // 默认必须还是旧的 6 / 10 / 4 / 5
  assert.deepEqual(small, { traits: 6, prefs: 10, threads: 4, events: 5 });
  assert.ok(mid.events > small.events && mid.prefs > small.prefs);
  assert.equal(big.traits, 12);
  assert.equal(big.events, 10);
  assert.ok(big.prefs >= 20, '偏好也要放大，20,000 时到 24 条');

  // 条数真的更多：同一张卡在 20,000 预算下拼出来的块更长，且不超过 memory 上限
  const card = personCard.newCard({ chatId: 'c', uid: 'u', name: '小海' });
  for (let i = 0; i < 20; i += 1) personCard.addPreference(card, { text: '偏好第' + i + '条', confidence: 0.8 }, { chatId: 'c' });
  for (let i = 0; i < 20; i += 1) personCard.addTrait(card, { text: '性格第' + i + '条', confidence: 0.8, evidence: ['m1', 'm2'] }, { chatId: 'c' });
  const evs = [];
  for (let i = 0; i < 10; i += 1) {
    evs.push({ date: '2026-10-1' + (i % 10), title: '事件' + i, summary: '摘要'.repeat(30), participants: ['u'], importance: 0.6, confidence: 0.8 });
  }
  const blockSmall = buildMemoryBlock({ card, events: evs, budget: planBudget(5500).memory, caps: small });
  const blockBig = buildMemoryBlock({ card, events: evs, budget: big.memory ? planBudget(20000).memory : 900, caps: big });
  assert.ok(blockBig.length > blockSmall.length, '大预算下展示的内容应更多');
  assert.ok(estimateBudgetTokens(blockBig) <= planBudget(20000).memory + 40, '不能超过 memory 分片');
});

test('关系卡：开启后只从 recent 里切，其它分片不动', () => {
  const off = planBudget(5500, { relations: false });
  const on = planBudget(5500, { relations: true });
  assert.equal(off.relations, 0);
  assert.equal(on.relations, LIMITS.relationsTokens);
  assert.equal(on.recent, off.recent - LIMITS.relationsTokens);
  assert.equal(on.memory, off.memory);
  assert.equal(on.summary, off.summary);
  assert.equal(on.reserve, off.reserve);
  assert.equal(on.total, 5500);
  // 比例同样是 2.18%，大预算下被上限夹住
  assert.equal(planBudget(20000, { relations: true }).relations, CEILINGS.relations);
  assert.equal(planBudget(20000, { relations: true }).total, 20000);
});

test('小预算：不会把 recent 吃空，也不会为负', () => {
  const p = planBudget(1000);
  assert.ok(p.recent >= 500, 'recent 至少一半：' + p.recent);
  assert.ok(p.summary >= 0 && p.memory >= 0 && p.reserve >= 0);
  assert.equal(p.total, 1000);
  assert.ok(p.warnings.includes('recent_below_floor') || p.recent >= 600);

  // 刚好触发回收的区间：摘要先让位，recent 补到 1,600
  const re = planBudget(2700);
  assert.equal(re.mode, 'reclaim');
  assert.equal(re.recent, 1600);
  assert.ok(re.summary < Math.round(SHARES.summary * 2700));
  assert.equal(re.total, 2700);
});

test('非法预算退回默认，不会抛', () => {
  for (const bad of [undefined, null, 0, -100, 'abc', NaN]) {
    const p = planBudget(bad);
    assert.equal(p.dialogueBudget, 5500);
    assert.equal(p.total, 5500);
  }
});

test('buildBudget：分片来自 plan，且带 relationsTokens', () => {
  const b = budget.buildBudget('人'.repeat(100));
  assert.equal(b.dialogueBudget, 5500);
  assert.equal(b.recentMaxTokens, 3200);
  assert.equal(b.memoryTokens, 900);
  assert.equal(b.summaryTokens, 900);
  assert.equal(b.reserveTokens, 500);
  assert.equal(b.relationsTokens, 0);
  assert.equal(b.plan.total, 5500);

  const big = budget.buildBudget('人'.repeat(100), { dialogueBudget: 20000 });
  assert.equal(big.dialogueBudget, 20000);
  assert.equal(big.recentMaxTokens, 15500);
  assert.equal(big.memoryTokens, CEILINGS.memory);
  assert.equal(big.estimatedPromptTokens, big.systemTokens, '没有 turns 时真估算只有 system');
  assert.equal(big.budgetCeilingTokens, big.systemTokens + 20000);
});

test('Store：调大对话预算后 recent 真的变多（旧代码这里是死代码）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plan-'));
  const store = makeStore(dir, { dialogueBudget: 20000 });
  const key = 'wechat:group:g1';
  seed(store, key, 80);
  const ctx = store.buildContext({ key, uid: 'u', name: '小海', query: '在吗', isGroup: true });
  assert.equal(ctx.plan.dialogueBudget, 20000);
  assert.equal(ctx.plan.recent, 15500);
  assert.ok(ctx.recentTokens > 3200, '20000 预算下 recent 应超过旧的 3,200：' + ctx.recentTokens);
  assert.ok(ctx.recentTokens <= 20000);
  assert.equal(ctx.compressed.chunks, 0, '预算够用就不该压缩');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('Store：默认预算仍是旧的 3,200 行为', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plan-'));
  const store = makeStore(dir);
  const key = 'wechat:group:g2';
  seed(store, key, 80);
  const ctx = store.buildContext({ key, uid: 'u', name: '小海', query: '在吗', isGroup: true });
  assert.equal(ctx.plan.recent, 3200);
  assert.ok(ctx.recentTokens <= 3200 + 400, '旧行为：recent 不超过 3,200：' + ctx.recentTokens);
  assert.equal(ctx.dialogueBudget, 5500);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('Store：压缩阈值跟着 recent 走，10,000 token 历史在 20,000 预算下不压缩', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plan-'));
  const store = makeStore(dir, { dialogueBudget: 20000 });
  const key = 'wechat:group:g3';
  const chat = seed(store, key, 160); // ≈ 10,000 token，超过旧硬阈值 3,200
  const ctx = store.buildContext({ key, uid: 'u', name: '小海', query: '在吗', isGroup: true });
  assert.equal(ctx.compressed.chunks, 0);
  assert.equal(chat.summary.segments.length, 0, '没有触发压缩，摘要应为空');
  // 条数上限也随预算放大（群聊 3,200 时是 100 条，20,000 时到 500 条上限）
  assert.ok(ctx.recentTokens > 10000, '趋势：recent 应接近 1 万 token：' + ctx.recentTokens);

  // 同一份历史换成默认预算，就必须压缩（证明阈值真的跟着 recent 走）
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plan-'));
  const small = makeStore(dir2);
  const key2 = 'wechat:group:g4';
  const chat2 = seed(small, key2, 160);
  const ctx2 = small.buildContext({ key: key2, uid: 'u', name: '小海', query: '在吗', isGroup: true });
  assert.ok(ctx2.compressed.chunks > 0, '默认预算下同样长度的历史必须被压缩');
  assert.ok(chat2.summary.segments.length > 0);
  assert.ok(ctx2.recentTokens <= 3200 + 400);

  store.close();
  small.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});



test('滑块 2,000–20,000 全区间都能用（总和、单调、上限）', () => {
  let prevRecent = 0;
  let prevCount = 0;
  for (let d = 2000; d <= 20000; d += 100) {
    const p = planBudget(d);
    assert.equal(p.total, d, 'D=' + d);
    assert.ok(p.recent >= prevRecent, 'recent 不能倒退：D=' + d);
    assert.ok(p.recentCount >= prevCount, '条数不能倒退：D=' + d);
    assert.ok(p.recent >= 1000, 'recent 太少了：D=' + d + ' → ' + p.recent);
    assert.ok(p.memory <= CEILINGS.memory && p.summary <= CEILINGS.summary && p.reserve <= CEILINGS.reserve);
    prevRecent = p.recent;
    prevCount = p.recentCount;
  }
});

test('输入框区间 1,000–62,000（含超出滑块的常用值）同样成立', () => {
  for (const d of [1000, 1500, 25000, 30000, 45000, 58000, 62000]) {
    const p = planBudget(d);
    assert.equal(p.total, d, 'D=' + d);
    assert.ok(p.recent > 0);
    assert.ok(p.memory <= CEILINGS.memory);
    assert.equal(p.relations, 0, '关系卡未启用时不占额度');
  }
});

test('填超过单轮硬上限：分片夹到 64,000，但该轮仍然拒绝', () => {
  const p = planBudget(100000);
  assert.equal(p.dialogueBudget, 64000, '分片按 64,000 算，不能涨到 10 万');
  assert.equal(p.requested, 100000, '原值要留着');
  assert.equal(p.total, 64000);
  assert.ok(p.warnings.includes('budget_above_hard_limit'));

  const b = budget.buildBudget('人'.repeat(100), {
    dialogueBudget: 100000,
    turns: [{ role: 'user', content: '人'.repeat(100000) }],
  });
  assert.ok(b.estimatedPromptTokens > 64000, '真实 turns 估算超过 64,000 才拒绝');
  assert.throws(() => budget.assertWithinHardLimit(b), (err) => err.code === 'BUDGET_EXCEEDED');
});

test('recent 占比有红线：滑块区间内 ≤85%，超过才告警', () => {
  for (let d = 2000; d <= 20000; d += 500) {
    const p = planBudget(d);
    assert.ok(p.recent / p.dialogueBudget <= 0.85, `D=${d} 的 recent 占比 ${(p.recent / p.dialogueBudget * 100).toFixed(1)}% 超过 85%`);
    assert.ok(!p.warnings.includes('recent_share_high'), `D=${d} 不该告警`);
  }
  const far = planBudget(40000);
  assert.ok(far.warnings.includes('recent_share_high'), '40,000 才该告警');
});


test('配额是硬上限：空卡不会让 recent 吃掉记忆的份额', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plan-'));
  const store = makeStore(dir, { dialogueBudget: 20000 });
  const key = 'wechat:group:g5';
  seed(store, key, 900); // ≈6 万 token，远超 recent 的 15,500，让 token 上限先到
  const plan = store.plan;
  // 全新成员：没有任何卡、没有任何事件
  const ctx = store.buildContext({ key, uid: 'brand_new', name: '新人', query: '在吗', isGroup: true });
  assert.equal(ctx.plan.memory, 2200, '记忆配额不因卡是空而降');
  // 这个块里含摘要，所以要扣掉摘要才是「卡」的实际占用
  const cardPart = ctx.memoryTokens - ctx.summaryTokens;
  assert.ok(cardPart < 80, '空卡实际只占几十个 token：' + cardPart);
  assert.ok(ctx.recentTokens <= plan.recent + 200, `recent 必须守在 ${plan.recent} 以内：${ctx.recentTokens}`);
  // 超上限先压缩到 75% 水位，然后一轮一轮往上长，所以落点总在 [75%, 100%] 之间
  assert.ok(ctx.recentTokens >= plan.recentLow - 500, '压到 75% 水位以下说明压过头了：' + ctx.recentTokens);
  assert.ok(ctx.recentTokens > 8000, '不会因为记忆空就缩水：' + ctx.recentTokens);
  // 三块加起来不能超过总预算（reserve 本来就是留白）
  // memoryTokens 里已经含了摘要正文，别再叠加 summaryTokens
  const used = ctx.recentTokens + ctx.memoryTokens;
  assert.ok(used <= plan.dialogueBudget, `实际用量 ${used} 超过预算 ${plan.dialogueBudget}`);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('配额是硬上限：卡再满也不会挤爆自己的分片', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plan-'));
  const store = makeStore(dir, { dialogueBudget: 20000 });
  const key = 'wechat:group:g6';
  const chat = store.chatStore.ensureChat(key, { platform: 'wechat', chatType: 'group' });
  const card = store.chatStore.ensurePerson(chat, 'rich', '话痨');
  for (let i = 0; i < 30; i += 1) personCard.addPreference(card, { text: '偏好第' + i + '条'.repeat(2), confidence: 0.8 }, { chatId: key });
  for (let i = 0; i < 12; i += 1) personCard.addTrait(card, { text: '性格第' + i + '条'.repeat(2), confidence: 0.8, evidence: ['m1', 'm2'] }, { chatId: key });
  for (let i = 0; i < 10; i += 1) {
    personCard.addEvent(card, {
      id: 'e' + i, date: '2026-10-1' + (i % 10), title: '事件' + i, summary: '摘要'.repeat(40),
      participants: ['rich'], importance: 0.7, confidence: 0.8, source: { chatId: key, messageIds: ['m' + i] },
    }, { chatId: key });
  }
  seed(store, key, 400, 40);
  const ctx = store.buildContext({ key, uid: 'rich', name: '话痨', query: '上次那事', isGroup: true });
  assert.ok(ctx.memoryTokens <= ctx.plan.memory + 40, `记忆块 ${ctx.memoryTokens} 超过配额 ${ctx.plan.memory}`);
  assert.ok(ctx.recentTokens <= ctx.plan.recent + 200, 'recent 不被记忆块挤动');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('推荐档位：四档、单调、estimate 里带提示', () => {
  assert.deepEqual(TIERS.map((t) => t.budget), [2000, 5500, 10000, 20000]);
  assert.equal(nearestTier(12000).label, '标准');
  assert.equal(nearestTier(5500).label, '默认');
  assert.equal(nearestTier(4300).label, '默认');
  assert.equal(nearestTier(1900).label, '极简');
  assert.equal(nearestTier(20000).label, '重度');
  const shares = TIERS.map((t) => planBudget(t.budget).recent / t.budget);
  assert.ok(Math.max(...shares) <= 0.85, '四档都在 85% 红线以内');
  assert.equal(Math.max(...shares), shares[3], '占比最高的是重度档');
  assert.ok(shares[0] <= 0.62 && shares[1] <= 0.62 && shares[2] <= 0.62, '前 10,000 以内原文占比都在 62% 以下');

  const est = require('../src/services/budget').estimate(
    require('../src/infra/config').loadConfig({ root: path.join(__dirname, '__nonexistent_tier__'), env: {} }),
    { dialogueBudget: 10000 },
  );
  assert.equal(est.tier.label, '标准');
  assert.equal(est.tiers.length, 4);
  assert.equal(est.tiers[3].recent, 15500);
});





