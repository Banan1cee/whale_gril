'use strict';

/**
 * 压缩：2,400 软预热 / 3,200 硬压缩 / 回落到 2,400 / 摘要 900 上限；
 * 压缩只影响 prompt 缓冲，不删原文；摘要失败时 coverage 不前进。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const compression = require('../src/memory/compression');
const { LIMITS } = require('../src/memory/constants');
const { estimateTokens } = require('../src/memory/tokens');
const { Store } = require('../src/memory/store');

function tempChat() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-compress-'));
  const store = new Store({ file: path.join(dir, 'data', 'store.json'), logger: null });
  const chat = store.chatStore.ensureChat('wechat:u:a', { platform: 'wechat', chatType: 'private' });
  return { store, chat, dir };
}

function fill(chat, n, chars = 100, startAt = 1) {
  for (let i = 0; i < n; i += 1) {
    chat.meta.nextSeq = startAt + i;
    const entry = { seq: startAt + i, role: i % 2 === 0 ? 'user' : 'assistant', name: '小海', text: '第' + i + '句' + '啊'.repeat(chars), ts: Date.now() + i };
    entry.tokens = estimateTokens(entry.text) + 4;
    chat.messages.push(entry);
  }
  chat.meta.nextSeq = startAt + n;
}

test('硬压缩：>3,200 压到 2,400 以下，当前消息永不进压缩块', () => {
  const { store, chat, dir } = tempChat();
  fill(chat, 50, 100); // 约 3,700+ token
  const current = chat.messages[chat.messages.length - 1];
  const before = compression.recentTokens(chat, { currentSeq: current.seq });
  assert.ok(before > LIMITS.hardTriggerTokens, '构造的原文要超过硬阈值：' + before);

  const result = compression.compressSync(chat, { currentSeq: current.seq });
  assert.ok(result.chunks >= 1);
  assert.ok(result.after <= LIMITS.recentLowTokens, '压完应回到 2,400 以下，实际 ' + result.after);
  assert.ok(compression.recentTokens(chat, { currentSeq: current.seq }) <= LIMITS.recentLowTokens);
  assert.ok(chat.messages.length, '原文一条都不能删');
  const covered = chat.messages.filter((m) => m.seq > chat.summary.coveredThroughSeq).map((m) => m.seq);
  assert.ok(current.seq > chat.summary.coveredThroughSeq, '当前消息不能被 covered');
  assert.ok(chat.summary.text.length > 0);
  assert.ok(chat.summary.tokens <= LIMITS.summaryTokens, '摘要不能超过 900 token');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('60 条短句只有几百 token：不该压缩', () => {
  const { store, chat, dir } = tempChat();
  fill(chat, 60, 4);
  const current = chat.messages[chat.messages.length - 1];
  const result = compression.compressSync(chat, { currentSeq: current.seq });
  assert.ok(compression.recentTokens(chat, { currentSeq: current.seq }) < LIMITS.hardTriggerTokens);
  assert.equal(result.chunks, 0);
  assert.equal(chat.summary.coveredThroughSeq, 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('软阈值：只准备摘要，不推进 coverage', async () => {
  const { store, chat, dir } = tempChat();
  fill(chat, 40, 100);
  const currentSeq = chat.meta.nextSeq;
  const llm = { isMock: false, async complete() { return '{"summary":"他最近在忙体检，情绪有点紧张。"}'; } };
  const before = chat.summary.coveredThroughSeq;
  const ok = await compression.prepareSoft(chat, { currentSeq, llm, now: Date.now() });
  assert.equal(ok, true);
  assert.ok(chat.pendingSummary && chat.pendingSummary.text.includes('体检'));
  assert.equal(chat.summary.coveredThroughSeq, before, '软预热不能动 coverage');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('摘要失败：原文保留，coveredThroughSeq 不前进', async () => {
  const { store, chat, dir } = tempChat();
  fill(chat, 50, 100);
  const coverageBefore = chat.summary.coveredThroughSeq;
  const llm = { isMock: false, async complete() { throw new Error('network down'); } };
  const result = await compression.compressAsync(chat, { currentSeq: 0, llm, requireLlm: true });
  assert.equal(result.failed, true);
  assert.equal(chat.summary.coveredThroughSeq, coverageBefore, '失败时水位不能前进');
  assert.equal(chat.messages.length, 50, '原文一条都不能删');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('摘要超过 900：合并最旧段，不直接丢事实', () => {
  const { store, chat, dir } = tempChat();
  fill(chat, 4, 20);
  for (let i = 0; i < 8; i += 1) {
    compression.applySegment(chat, {
      text: '第' + i + '段摘要：' + '事'.repeat(200),
      fromSeq: i * 2 + 1,
      toSeq: i * 2 + 2,
      now: Date.now() + i,
    });
  }
  assert.ok(chat.summary.tokens <= LIMITS.summaryTokens, '摘要应被压到 900 以内：' + chat.summary.tokens);
  assert.ok(chat.summary.segments.length >= 1);
  assert.ok(chat.summary.text.includes('更早：') || chat.summary.segments.length === 1, '最旧段应被合并');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('llmSummary：能从代码块里抠出摘要；格式不对返回空', async () => {
  const ok = await compression.llmSummary([{ role: 'user', name: '小海', text: '在吗' }], {
    isMock: false,
    async complete() { return '```json\n{"summary":"他们在聊体检"}\n```'; },
  });
  assert.equal(ok, '他们在聊体检');
  const bad = await compression.llmSummary([{ role: 'user', name: '小海', text: '在吗' }], {
    isMock: false,
    async complete() { return '我不会 JSON'; },
  });
  assert.equal(bad, '');
});

test('recentForPrompt：从新往旧装，当前消息超长也保留（只截断）', () => {
  const { store, chat, dir } = tempChat();
  fill(chat, 20, 100);
  const current = { seq: 999, role: 'user', name: '小海', text: '当'.repeat(3000), ts: Date.now(), tokens: 3000 };
  chat.messages.push(current);
  const out = compression.recentForPrompt(chat, { currentSeq: current.seq, maxTokens: LIMITS.recentMaxTokens });
  assert.ok(out.messages.some((m) => m.seq === current.seq), '当前消息必须在');
  assert.ok(out.messages.find((m) => m.seq === current.seq).text.length <= LIMITS.maxTurnChars);
  assert.ok(out.tokens <= LIMITS.recentMaxTokens + 400, '总预算不能离谱：' + out.tokens);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});
