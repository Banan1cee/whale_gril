'use strict';

/**
 * 关停 / 崩溃边界：
 *  - 直接 terminate 进程（用 worker 模拟）后，用户消息、回复、人物卡、checkpoint 是否还在
 *  - 正在压缩（同步已 apply 但 summary 还没写盘 / 异步等模型）时被关掉，会不会丢原文
 *  - 正在写 episode L2 时被关掉，重启后会不会重复写 / 丢条目
 *  - 整段服务回复完立刻被关掉，重启还能不能接上
 *
 * 这些测试故意不调用 close()，用 worker.terminate() 模拟「任务管理器结束进程」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { Store } = require('../src/memory/store');
const { chatHash } = require('../src/memory/hash');
const personCard = require('../src/memory/personCard');

const ROOT = path.resolve(__dirname, '..');
const STORE_PATH = path.join(ROOT, 'src', 'memory', 'store.js');
const COMPRESSION_PATH = path.join(ROOT, 'src', 'memory', 'compression.js');
const SERVER_PATH = path.join(ROOT, 'server.js');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whale-crash-'));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function storeFile(root) {
  return path.join(root, 'data', 'store.json');
}

function messagesFile(root, key) {
  return path.join(root, 'data', 'memory', 'chats', chatHash(key), 'messages.jsonl');
}

/** 起一个 worker，等它 post ready（或 error） */
function bootWorker(source, workerData, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData });
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      reject(new Error('worker 启动超时'));
    }, timeoutMs);
    const fail = (err) => {
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      reject(err);
    };
    worker.once('error', fail);
    worker.once('message', (msg) => {
      clearTimeout(timer);
      if (msg && msg.error) return fail(new Error(msg.error));
      resolve({ worker, msg });
    });
  });
}

async function kill(worker) {
  try { await worker.terminate(); } catch { /* 已经退出 */ }
}

async function readMessages(root, key) {
  const store = new Store({ file: storeFile(root), logger: null });
  try {
    return store.messages(key, 10000).map((m) => ({ ...m }));
  } finally {
    store.close();
  }
}

const STORE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require(workerData.storePath);
const compression = require(workerData.compressionPath);
(async () => {
  const store = new Store({ file: path.join(workerData.root, 'data', 'store.json'), logger: null });
  const key = 'wechat:u:crash';
  const mode = workerData.mode;
  if (mode === 'message') {
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '关停前的用户消息', msgId: 'crash-msg-1' });
    store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '关停前的回复' });
    store.addNote(key, 'u1', '喜欢猫');
    store.checkpoint(key);
  } else if (mode === 'compress-sync') {
    for (let i = 0; i < 50; i += 1) {
      store.appendMessage(key, { role: i % 2 ? 'assistant' : 'user', name: i % 2 ? '鲸鲸' : '小海', uid: 'u1', text: '同一话题第' + i + '句' + '啊'.repeat(90), ts: Date.now() + i });
    }
    const chat = store.chatStore.chats.get(key);
    // 只 apply 到内存，故意不 saveSummary —— 模拟压缩到一半被 kill
    compression.compressSync(chat, { currentSeq: 0, now: Date.now() });
  } else if (mode === 'compress-async') {
    for (let i = 0; i < 50; i += 1) {
      store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '同一话题第' + i + '句' + '啊'.repeat(90), ts: Date.now() + i });
    }
    const chat = store.chatStore.chats.get(key);
    // 永远不返回的模型：压缩一直挂在 await 上
    compression.compressAsync(chat, {
      currentSeq: 0,
      llm: { isMock: false, async complete() { return new Promise(() => {}); } },
      logger: null,
    }).catch(() => {});
  } else if (mode === 'episode-wait') {
    const old = Date.now() - 2 * 3600 * 1000;
    for (let i = 0; i < 4; i += 1) {
      store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '两小时前聊的事第' + i + '句', ts: old + i });
    }
    // 模型永远不返回：L2 一条都还没写
    store.closeEpisode(key, {
      llm: { isMock: false, async complete() { return new Promise(() => {}); } },
      now: Date.now(),
    }).catch(() => {});
  } else if (mode === 'partial-l2') {
    for (let i = 0; i < 3; i += 1) {
      store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '写 L2 写到一半第' + i + '句', ts: Date.now() + i });
    }
    const llm = {
      isMock: false,
      async complete() {
        return JSON.stringify({
          summary: '在聊一件事，还没聊完。',
          facts: [{ uid: 'u1', text: '在聊一件事', confidence: 0.8 }],
          traits: [],
          events: [{ uid: 'u1', title: '一件事', summary: '这段聊了一件事，还没结束。', keywords: ['一件事'], importance: 0.6, confidence: 0.8 }],
          threads: [{ uid: 'u1', text: '这件事还没聊完' }],
        });
      },
    };
    // 模拟「卡片/摘要写完了，meta 还没落盘就断电」：让 meta 写入变成空操作
    const original = store.chatStore.saveMeta.bind(store.chatStore);
    store.chatStore.saveMeta = () => {};
    await store.closeEpisode(key, { llm, now: Date.now() + 10 });
    // 恢复引用，防止 worker 退出阶段出问题（但不会再写，因为已经 post 了）
    store.chatStore.saveMeta = original;
  } else if (mode === 'meta') {
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '只写了一条用户消息' });
  }
  parentPort.postMessage({ ready: true });
  setInterval(() => {}, 1000);
})().catch((err) => parentPort.postMessage({ error: String(err && err.stack || err) }));
`;

test('直接 kill：用户消息 / 回复 / 人物卡 / checkpoint 都还在', async () => {
  const root = tempRoot();
  const { worker } = await bootWorker(STORE_WORKER, { root, storePath: STORE_PATH, compressionPath: COMPRESSION_PATH, mode: 'message' });
  await kill(worker);

  const messages = await readMessages(root, 'wechat:u:crash');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, '关停前的用户消息');
  assert.equal(messages[1].text, '关停前的回复');

  const store = new Store({ file: storeFile(root), logger: null });
  try {
    assert.equal(store.listNotes('wechat:u:crash')[0].notes[0], '喜欢猫');
    assert.equal(store.isDuplicate('wechat:u:crash', 'crash-msg-1'), true, '去重 id 也要在 kill 前落盘');
    const chat = store.chatStore.chats.get('wechat:u:crash');
    assert.ok(chat.meta.checkpointSeq >= 2, 'checkpoint 要落盘');
    assert.ok(fs.existsSync(path.join(chat.dir, 'checkpoints', String(chat.meta.checkpointSeq).padStart(8, '0') + '.json')));
  } finally {
    store.close();
  }
  cleanup(root);
});

test('kill 在 meta 防抖窗口内：episode 水位也要落盘，不能丢段', async () => {
  const root = tempRoot();
  const { worker } = await bootWorker(STORE_WORKER, { root, storePath: STORE_PATH, compressionPath: COMPRESSION_PATH, mode: 'meta' });
  await kill(worker);

  const store = new Store({ file: storeFile(root), logger: null });
  try {
    const chat = store.chatStore.chats.get('wechat:u:crash');
    assert.equal(store.messages('wechat:u:crash', 10).length, 1);
    assert.ok(chat.meta.episode, 'episode 不能因为 400ms 防抖没写就消失');
    assert.equal(chat.meta.episode.messageSeqTo, 1);
    assert.ok(chat.meta.stats.userMessages >= 1);
  } finally {
    store.close();
  }
  cleanup(root);
});

test('kill 在同步压缩「已 apply、未写 summary」之间：原文一条不丢，水位不前进', async () => {
  const root = tempRoot();
  const { worker } = await bootWorker(STORE_WORKER, { root, storePath: STORE_PATH, compressionPath: COMPRESSION_PATH, mode: 'compress-sync' });
  await kill(worker);

  const messages = await readMessages(root, 'wechat:u:crash');
  assert.equal(messages.length, 50, '原文不能因为压缩到一半就少了');
  const store = new Store({ file: storeFile(root), logger: null });
  try {
    const chat = store.chatStore.chats.get('wechat:u:crash');
    assert.equal(chat.summary.coveredThroughSeq, 0, 'summary 没写盘，水位不能前进');
    assert.equal(chat.messages.length, 50);
    // 重启后重新压缩仍然能正常工作
    const ctx = store.buildContext({ key: 'wechat:u:crash', uid: 'u1', name: '小海', query: '第49句' });
    assert.ok(ctx.recent.length > 0);
    assert.ok(chat.messages.length === 50, '重建上下文不能删原文');
  } finally {
    store.close();
  }
  cleanup(root);
});

test('kill 在异步压缩等模型时：原文完整，尚未产生半截摘要', async () => {
  const root = tempRoot();
  const { worker } = await bootWorker(STORE_WORKER, { root, storePath: STORE_PATH, compressionPath: COMPRESSION_PATH, mode: 'compress-async' });
  // 等 worker 真正进入 await（compressAsync 是异步的，ready 已 post）
  await new Promise((r) => setTimeout(r, 200));
  await kill(worker);

  const messages = await readMessages(root, 'wechat:u:crash');
  assert.equal(messages.length, 50);
  const store = new Store({ file: storeFile(root), logger: null });
  try {
    const chat = store.chatStore.chats.get('wechat:u:crash');
    assert.equal(chat.summary.coveredThroughSeq, 0);
    assert.equal(chat.summary.segments.length, 0);
  } finally {
    store.close();
  }
  cleanup(root);
});

test('kill 在 episode L2 等模型时：原文在；重启后还能补写', async () => {
  const root = tempRoot();
  const { worker } = await bootWorker(STORE_WORKER, { root, storePath: STORE_PATH, compressionPath: COMPRESSION_PATH, mode: 'episode-wait' });
  await new Promise((r) => setTimeout(r, 200));
  await kill(worker);

  const messages = await readMessages(root, 'wechat:u:crash');
  assert.equal(messages.length, 4, 'L2 没写成也不能丢原文');
  const store = new Store({ file: storeFile(root), logger: null });
  try {
    const chat = store.chatStore.chats.get('wechat:u:crash');
    assert.ok(chat.meta.episode, 'episode 还开着，重启可以补写');
    assert.equal(personCard.activeEvents(chat.people.get('u1')).length, 0);
    // 重启补写：给一个能返回的模型
    store.llm = {
      isMock: false,
      async complete() {
        return JSON.stringify({
          summary: '两小时前聊了几句话。', facts: [], traits: [],
          events: [{ uid: 'u1', title: '两小时前的事', summary: '两小时前聊了几句话。', keywords: [], importance: 0.5, confidence: 0.7 }],
          threads: [],
        });
      },
    };
    const r = await store.closeEpisode('wechat:u:crash', { llm: store.llm, now: Date.now() });
    assert.equal(r.closed, true);
    assert.ok(personCard.activeEvents(chat.people.get('u1')).length >= 1);
  } finally {
    store.close();
  }
  cleanup(root);
});

test('kill 在 L2 卡片写完、meta 未写时：重启补写不产生重复事件', async () => {
  const root = tempRoot();
  const { worker } = await bootWorker(STORE_WORKER, { root, storePath: STORE_PATH, compressionPath: COMPRESSION_PATH, mode: 'partial-l2' });
  await kill(worker);

  const store = new Store({ file: storeFile(root), logger: null });
  try {
    const chat = store.chatStore.chats.get('wechat:u:crash');
    const card = chat.people.get('u1');
    const before = personCard.activeEvents(card).length;
    assert.equal(before, 1, '第一遍已经写了一条事件');
    assert.equal(chat.meta.closedEpisodes.length, 0, 'meta 没写盘，closedEpisodes 还是空的');

    // 重启后再次关闭同一个 episode：事件 id 相同，只能更新不能新增
    store.llm = {
      isMock: false,
      async complete() {
        return JSON.stringify({
          summary: '同一段事。', facts: [], traits: [],
          events: [{ uid: 'u1', title: '一件事', summary: '这段聊了一件事，还没结束。', keywords: [], importance: 0.6, confidence: 0.8 }],
          threads: [],
        });
      },
    };
    const r = await store.closeEpisode('wechat:u:crash', { llm: store.llm, now: Date.now() });
    assert.equal(r.closed, true);
    const after = personCard.activeEvents(chat.people.get('u1')).length;
    assert.equal(after, before, '补写不能产生重复事件');
    assert.equal(chat.meta.closedEpisodes.length, 1);
  } finally {
    store.close();
  }
  cleanup(root);
});

/* ------------------------------------------------------------------ */
/* 整段服务：回复完立刻 kill / 回复途中 kill                            */
/* ------------------------------------------------------------------ */

const SERVER_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require(workerData.serverPath);
(async () => {
  fs.mkdirSync(path.join(workerData.root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(workerData.root, 'config.json'), JSON.stringify({
    server: { port: 0, openBrowser: false },
    watchConfig: false,
    log: { level: 'error' },
    gateway: { wechat: { inboundToken: 'crash-token' } },
  }));
  const inst = await startServer({ root: workerData.root, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  inst.runtime.bot.mockChunkDelayMs = workerData.delay || 0;
  parentPort.postMessage({ ready: true, url: inst.url, token: 'crash-token' });
  setInterval(() => {}, 1000);
})().catch((err) => parentPort.postMessage({ error: String(err && err.stack || err) }));
`;

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test('整段服务：回复完立刻 kill，重启后用户消息和回复都在', async () => {
  const root = tempRoot();
  const { worker, msg } = await bootWorker(SERVER_WORKER, { root, serverPath: SERVER_PATH, delay: 0 }, 25000);
  try {
    const res = await fetch(msg.url + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': msg.token },
      body: JSON.stringify({ text: '我叫小海，今天加班好累', mode: 'private', sessionId: 'crash-s1', senderName: '小海' }),
    });
    const body = await res.text();
    assert.match(body, /done/);
    await kill(worker);

    const messages = await readMessages(root, 'web:u:crash-s1:private');
    assert.ok(messages.length >= 2, '用户消息 + 回复都要在：' + messages.length);
    assert.ok(messages.some((m) => m.role === 'user' && m.text.includes('加班')));
    assert.ok(messages.some((m) => m.role === 'assistant' && m.text.trim()));

    const store = new Store({ file: storeFile(root), logger: null });
    try {
      const chat = store.chatStore.chats.get('web:u:crash-s1:private');
      assert.ok(chat.meta.episode, 'episode 要能接上');
      assert.ok(chat.meta.checkpointSeq >= 2);
    } finally {
      store.close();
    }
  } finally {
    await kill(worker);
    cleanup(root);
  }
});

test('整段服务：回复途中 kill，已收到的用户消息不丢（回复可以没有）', async () => {
  const root = tempRoot();
  const { worker, msg } = await bootWorker(SERVER_WORKER, { root, serverPath: SERVER_PATH, delay: 400 }, 25000);
  try {
    const pending = fetch(msg.url + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': msg.token },
      body: JSON.stringify({ text: '关停时正在处理的消息', mode: 'private', sessionId: 'crash-s2', senderName: '小海' }),
    }).catch(() => null);

    // 等用户消息先落盘（appendMessage 在生成回复之前）
    const file = messagesFile(root, 'web:u:crash-s2:private');
    const ok = await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('关停时正在处理的消息'));
    assert.equal(ok, true, '用户消息应该在回复前就落盘');
    await kill(worker);
    await pending;

    const messages = await readMessages(root, 'web:u:crash-s2:private');
    assert.ok(messages.some((m) => m.role === 'user' && m.text.includes('关停时正在处理的消息')));
  } finally {
    await kill(worker);
    cleanup(root);
  }
});
