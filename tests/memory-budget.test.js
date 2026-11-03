'use strict';

/**
 * token 估算 + 预算语义：
 *   estimatedPromptTokens === system + 实际 turns（不再用 system + dialogueBudget）
 *   dialogueBudget 保留给裁剪；system 只测量，不裁剪；真实估算超过 64,000 才报错
 *   recent 仍然是 3,200 硬上限，不受 system 变大影响
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { LIMITS } = require('../src/memory/constants');
const { estimateTokens, estimateBudgetTokens, messageTokens, messageBudgetTokens } = require('../src/memory/tokens');
const budget = require('../src/memory/budget');
const { Store } = require('../src/memory/store');
const { buildMemoryBlock } = require('../src/memory/format');
const personCard = require('../src/memory/personCard');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('tokens：中文 ≈0.65/字，英文 ≈0.3/字，混合按各自比例', () => {
  assert.equal(estimateTokens('中'.repeat(100)), 65);
  assert.equal(estimateTokens('a'.repeat(100)), 30);
  // 100 中文 + 100 英文 = 65 + 30
  assert.equal(estimateTokens('中'.repeat(100) + 'a'.repeat(100)), 95);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('   \n\t '), 0);
});

test('tokens：预算裁剪乘 1.08 安全系数；消息另有约 4 token 固定开销', () => {
  assert.ok(estimateBudgetTokens('中'.repeat(100)) > estimateTokens('中'.repeat(100)));
  assert.equal(estimateBudgetTokens('中'.repeat(100)), Math.ceil(65 * 1.08));
  const m = { role: 'user', name: '', text: '中'.repeat(100) };
  assert.ok(messageTokens(m) >= 65 + 4);
  assert.ok(messageBudgetTokens(m) > messageTokens(m));
});

test('budget：estimatedPromptTokens = system + turns，dialogueBudget 仍保留', () => {
  const turns = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在呢' },
  ];
  const b = budget.buildBudget('人'.repeat(1000), { turns });
  assert.equal(b.systemTokens, 650);
  assert.equal(b.dialogueBudget, 5500);
  assert.equal(b.estimatedPromptTokens, 650 + turns.reduce((n, t) => n + messageTokens(t), 0));
  assert.equal(b.estimatedInputTokens, b.estimatedPromptTokens);
  assert.ok(b.estimatedPromptTokens < b.systemTokens + 5500);
  assert.equal(b.budgetCeilingTokens, b.systemTokens + 5500);
  assert.equal(b.hardTotalTokens, 64000);
});

test('budget：system 很大也只测量，不裁剪、不挤 recent', () => {
  const bigSystem = '人'.repeat(20000); // ≈13,000 token
  const b = budget.assertWithinHardLimit(budget.buildBudget(bigSystem));
  assert.equal(b.systemTokens, 13000);
  assert.equal(b.estimatedPromptTokens, 13000);
  assert.equal(b.recentMaxTokens, LIMITS.recentMaxTokens);
  assert.equal(b.recentMaxTokens, 3200);
  assert.equal(b.memoryTokens, 900);
  assert.equal(b.summaryTokens, 900);
  assert.equal(b.dialogueBudget, LIMITS.memoryTokens + LIMITS.summaryTokens + LIMITS.recentMaxTokens + LIMITS.reserveTokens);
  // 估算函数本身不做截断
  assert.equal(estimateTokens(bigSystem), 13000);
});

test('budget：只有真实估算 > 64,000 才报错', () => {
  // 58,500 system token，没有 turns：真实估算就是 58,500，不报错
  const ok = budget.buildBudget('人'.repeat(90000));
  assert.equal(ok.systemTokens, 58500);
  assert.equal(ok.estimatedPromptTokens, 58500);
  assert.doesNotThrow(() => budget.assertWithinHardLimit(ok));

  const tooBig = budget.buildBudget('人'.repeat(100000)); // 65,000 token
  assert.equal(tooBig.estimatedPromptTokens, 65000);
  assert.ok(tooBig.estimatedPromptTokens > 64000);
  assert.throws(() => budget.assertWithinHardLimit(tooBig), (err) => {
    assert.equal(err.code, 'BUDGET_EXCEEDED');
    assert.match(err.message, /超过硬上限/);
    return true;
  });
});

test('compareUsage：只在实际用量超出估算 >15% 时告警', () => {
  const b = { estimatedPromptTokens: 7000 };
  const ok = budget.compareUsage(b, { promptTokens: 6500 });
  assert.equal(ok.warn, false);
  assert.equal(ok.direction, 'under');
  const edge = budget.compareUsage(b, { promptTokens: 7200 });
  assert.equal(edge.warn, false);
  const bad = budget.compareUsage(b, { promptTokens: 10000 });
  assert.equal(bad.warn, true);
  assert.equal(bad.direction, 'over');
  assert.ok(bad.errorRatio > 0.15);
  assert.equal(budget.compareUsage(b, null), null);
  // 校准后的估算参与比较
  const scaled = budget.compareUsage(b, { promptTokens: 6300 }, { scale: 1.2 });
  assert.equal(scaled.estimatedPromptTokens, 8400);
  assert.equal(scaled.warn, false);
});

test('memory 块预算仍是 900，且不随 system 变大而变', () => {
  const card = personCard.newCard({ chatId: 'c', uid: 'u', name: '小海' });
  personCard.addPreference(card, { text: '喜欢猫', confidence: 0.8 }, { chatId: 'c' });
  const small = buildMemoryBlock({ card, events: [], summary: '' });
  assert.ok(estimateBudgetTokens(small) <= LIMITS.memoryTokens);
  assert.equal(LIMITS.memoryTokens, 900);
});

test('Store.buildContext：recent 仍受 3,200 限制，system 不参与', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-budget-'));
  const store = new Store({ file: path.join(dir, 'data', 'store.json'), logger: null });
  const chat = store.chatStore.ensureChat('wechat:u:a', { platform: 'wechat', chatType: 'private' });
  for (let i = 0; i < 80; i += 1) {
    chat.meta.nextSeq = i + 1;
    chat.messages.push({
      seq: i + 1, role: 'user', name: '小海', text: '第' + i + '句话' + '啊'.repeat(80),
      ts: Date.now() + i, tokens: estimateTokens('第' + i + '句话' + '啊'.repeat(80)) + 4,
    });
  }
  chat.meta.nextSeq = 81;
  const ctx = store.buildContext({ key: 'wechat:u:a', uid: 'u', name: '小海', query: '在吗' });
  assert.ok(ctx.recentTokens <= LIMITS.recentMaxTokens + 400, 'recent 不能因 system 变大而涨：' + ctx.recentTokens);
  assert.equal(ctx.dialogueBudget, 5500);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});
