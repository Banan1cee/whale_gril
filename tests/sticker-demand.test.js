'use strict';

/**
 * 表情包节奏 + 现实索要兜底 + 缓存 usage 解析。
 * 这些用例不启服务、不连模型。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Bot } = require('../src/pipeline/chat');
const stickers = require('../src/adapters/stickers');
const { DeepSeekClient } = require('../src/llm/client');

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-demand-'));
  fs.mkdirSync(path.join(root, 'data/stickers/开心'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data/stickers/傲娇'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data/stickers/炸毛'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/stickers/开心/a.png'), 'x');
  fs.writeFileSync(path.join(root, 'data/stickers/傲娇/b.png'), 'x');
  fs.writeFileSync(path.join(root, 'data/stickers/炸毛/c.png'), 'x');
  return root;
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
}

test('索要话术：发/来/给 + 表情、用表情告诉我、倒装、来张图都算；否定式不算', () => {
  for (const text of [
    '给我发个表情',
    '你现在发个表情来说明你的心情',
    '发个表情呗',
    '来张图',
    '用表情包告诉我你现在什么心情',
    '发个表情包',
    '给我整个动图',
    '表情包来一个',
  ]) {
    assert.equal(stickers.isStickerRequest(text), true, JSON.stringify(text));
  }
  for (const text of ['不要发表情包', '别发个表情', '不用发图', '发个消息']) {
    assert.equal(stickers.isStickerRequest(text), false, JSON.stringify(text));
  }
});

test('严肃窗口：15 分钟 / 连续 4 条普通消息才解除，会说「没事了」可以提前解除', () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  const state = {};
  const call = (text, at) => Bot.prototype.updateSeriousState.call({}, state, 'u1', text, at);

  assert.equal(call('我失恋了', now), true);
  assert.ok(state.seriousByUser.u1.until >= now + stickers.SERIOUS_WINDOW_MS - 1);
  assert.equal(call('嗯', now + 1000), true, '窗口内普通消息仍是严肃');
  assert.equal(call('哦', now + 2000), true);
  assert.equal(call('在吗', now + 3000), true);
  assert.equal(call('今天天气不错', now + 4000), false, '第 4 条普通消息解除');
  assert.equal(state.seriousByUser.u1, undefined);

  assert.equal(call('我生病了', now + 5 * 60 * 1000), true);
  assert.equal(call('好多了', now + 5 * 60 * 1000 + 1000), false, '好转词提前解除');

  assert.equal(call('我崩溃了', now + 6 * 60 * 1000), true);
  assert.equal(call('嗯', now + 6 * 60 * 1000 + stickers.SERIOUS_WINDOW_MS + 1), false, '过了 15 分钟自动解除');
});

test('严肃状态按说话人隔离：A 难过不影响 B', () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  const state = {};
  const call = (uid, text, at) => Bot.prototype.updateSeriousState.call({}, state, uid, text, at);
  assert.equal(call('u1', '我失恋了', now), true);
  assert.equal(call('u2', '哈哈', now + 1000), false, '另一个人不在 A 的严肃窗口里');
});

test('节奏：明确索要必真；只拦严肃；其余按 demandChance', () => {
  const root = tmpRoot();
  try {
    const base = {
      root,
      features: { stickers: true },
      sticker: { dir: 'data/stickers', demandChance: 0.65 },
    };
    const makeCtx = (rng, extra = {}) => ({
      config: { ...base, ...extra },
      rng: () => rng,
      updateSeriousState: Bot.prototype.updateSeriousState,
    });
    const now = Date.UTC(2026, 10, 3, 12, 0, 0);
    const args = { uid: 'u1', nowMs: now };

    assert.equal(Bot.prototype.stickerDemandFor.call(makeCtx(0.99), { ...args, state: {}, text: '发个表情包' }), true);
    assert.equal(Bot.prototype.stickerDemandFor.call(makeCtx(0.99), { ...args, state: {}, text: '我失恋了' }), false);
    assert.equal(Bot.prototype.stickerDemandFor.call(makeCtx(0.1), { ...args, state: {}, text: '在吗' }), true);
    assert.equal(Bot.prototype.stickerDemandFor.call(makeCtx(0.9), { ...args, state: {}, text: '在吗' }), false);
    assert.equal(Bot.prototype.stickerDemandFor.call(makeCtx(0.1), { ...args, state: {}, text: '在吗', fight: true }), true, '对喷不拦，可以发炸毛');
    assert.equal(Bot.prototype.stickerDemandFor.call(makeCtx(0.1), { ...args, state: {}, text: '在吗', discussion: true }), true, '讨论状态不拦，否则 10 分钟都发不出');
    assert.equal(Bot.prototype.stickerDemandFor.call(
      makeCtx(0.1, { sticker: { dir: 'data/stickers', demandChance: 0 } }), { ...args, state: {}, text: '在吗' }), false);
    assert.equal(Bot.prototype.stickerDemandFor.call(
      makeCtx(0.99, { sticker: { dir: 'data/stickers', demandChance: 1 } }), { ...args, state: {}, text: '在吗' }), true);
  } finally {
    cleanup(root);
  }
});

test('stickerFor：明确索要但模型没写标记时会补分类；空分类会映射；没图不发', () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, 'data/stickers/撒娇'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/stickers/撒娇/c.png'), 'x');
    fs.writeFileSync(path.join(root, 'data/sticker-categories.json'),
      JSON.stringify([{ label: '撒娇', chance: 0.25 }]), 'utf8');
    const config = {
      root,
      features: { stickers: true },
      sticker: { dir: 'data/stickers', demandChance: 0.65 },
    };
    const seen = [];
    const ctx = {
      config,
      stickerService: { plan: (msg, category) => { seen.push(category); return { emotion: category }; } },
      logger: null,
    };
    const call = (decision) => Bot.prototype.stickerFor.call(ctx, decision, '');

    assert.deepEqual(call({ msg: { platform: 'wechat', chatId: 'c1', text: '发个表情包' } }), { emotion: 'happy' });
    assert.deepEqual(call({
      msg: { platform: 'wechat', chatId: 'c1', text: '发个撒娇表情' },
      stickerCategory: '撒娇',
    }), { emotion: 'x:撒娇' }, '自定义分类按名字认');
    assert.deepEqual(call({
      msg: { platform: 'wechat', chatId: 'c1', text: '在吗' },
      stickerCategory: '不存在的分类',
    }), { emotion: 'happy' }, '空分类/写错名字映射到有图的默认分类');
    assert.equal(call({ msg: { platform: 'wechat', chatId: 'c1', text: '在吗' } }), null, '没标记也没索要就不发');
    assert.deepEqual(seen, ['happy', 'x:撒娇', 'happy']);
  } finally {
    cleanup(root);
  }
});

test('ensureSend：命中提醒且开必发时，模型没写标记也按语气补一张；没命中不补', () => {
  const root = tmpRoot();
  try {
    const makeCtx = (ensure) => {
      const seen = [];
      return {
        seen,
        ctx: {
          config: {
            root,
            features: { stickers: true },
            sticker: { dir: 'data/stickers', demandChance: 0.7, ensureSend: ensure },
          },
          stickerService: { plan: (msg, category) => { seen.push(category); return { emotion: category }; } },
          logger: null,
        },
      };
    };
    const on = makeCtx(true);
    assert.deepEqual(Bot.prototype.stickerFor.call(on.ctx, {
      msg: { platform: 'wechat', chatId: 'c1', text: '气死我了' },
      stickerDemand: true,
    }, '别气了'), { emotion: 'angry' }, '生气语气补炸毛');
    assert.deepEqual(Bot.prototype.stickerFor.call(on.ctx, {
      msg: { platform: 'wechat', chatId: 'c1', text: '在吗' },
      stickerDemand: true,
    }, '在呢'), { emotion: 'happy' }, '没明显语气补默认开心');
    assert.equal(Bot.prototype.stickerFor.call(on.ctx, {
      msg: { platform: 'wechat', chatId: 'c1', text: '在吗' },
      stickerDemand: false,
    }, '在呢'), null, '没命中提醒不补');

    const off = makeCtx(false);
    assert.equal(Bot.prototype.stickerFor.call(off.ctx, {
      msg: { platform: 'wechat', chatId: 'c1', text: '在吗' },
      stickerDemand: true,
    }, '在呢'), null, '没开必发不补');
  } finally {
    cleanup(root);
  }
});

test('缓存 usage：OpenCode 的 cache_read / cached_tokens、DeepSeek 的 prompt_cache_hit_tokens 都能读到', () => {
  const call = (usage) => {
    const ctx = { usageSeq: 0, usageEvents: [] };
    DeepSeekClient.prototype._recordUsage.call(ctx, { usage });
    return ctx.lastUsage;
  };
  const a = call({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens: 10 });
  assert.equal(a.promptCacheHitTokens, 800);
  assert.equal(a.promptCacheMissTokens, 200);

  const b = call({ prompt_tokens: 900, opencode: { tokens: { cache_read: 700 } }, completion_tokens: 5 });
  assert.equal(b.promptCacheHitTokens, 700);
  assert.equal(b.promptCacheMissTokens, 200);

  const c = call({ prompt_tokens: 500, prompt_cache_hit_tokens: 300, completion_tokens: 5 });
  assert.equal(c.promptCacheHitTokens, 300);
  assert.equal(c.promptCacheMissTokens, 200);

  const d = call({ prompt_tokens: 100, opencode: { tokens: { cache_read: 500 } }, completion_tokens: 5 });
  assert.equal(d.promptCacheHitTokens, 100, '命中不能超过输入');
});
