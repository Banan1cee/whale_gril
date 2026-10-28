'use strict';

// No server, config, filesystem writes, or WeChat: run the debug page with a fake DOM/network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ enabled = true, jobs = [] } = {}) {
  const ids = new Map();
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = new Map();
      this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
      this.textContent = ''; this.dataset = {}; this.style = {}; this.files = [];
    }
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id; }
    set innerHTML(value) { this._html = value; this.children = []; }
    get innerHTML() { return this._html || ''; }
    appendChild(child) { this.children.push(child); if (this.tagName === 'SELECT' && this.children.length === 1) this.value = child.value; return child; }
    replaceChildren(...children) { this.children = children; }
    addEventListener(event, fn) { const list = this.listeners.get(event) || []; list.push(fn); this.listeners.set(event, list); }
    async dispatch(event) { await Promise.all((this.listeners.get(event) || []).map((fn) => fn({}))); }
  }
  const html = fs.readFileSync(path.join(__dirname, '../web/debug.html'), 'utf8');
  for (const [, tag, id] of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) { const element = new Element(tag); element.id = id; }
  ids.get('stkControls').hidden = true;
  ids.get('stkChat').value = '文件传输助手';
  const calls = []; const intervals = new Map(); let timerId = 0;
  const status = { ok: true, enabled: true, testChat: '默认会话', dir: 'virtual/stickers', pending: 0, jobs,
    emotions: ['happy', 'angry', 'cute', 'meh', 'bored'].map((key) => ({ key, count: key === 'happy' ? 2 : 0, files: [] })) };
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || 'GET', body });
    let data;
    if (url === '/api/features' && options.method === 'POST') { enabled = body.value; data = { ok: true, value: enabled }; }
    else if (url === '/api/features') data = { ok: true, features: [{ key: 'stickers', value: enabled }] };
    else if (url === '/api/stickers/status') data = enabled ? status : { ok: false };
    else if (url === '/api/stickers/test') data = { ok: true, queued: { id: 'job-1', status: 'queued' } };
    else if (url === '/api/stickers/upload') data = { ok: true, uploaded: body.files.map((file) => ({ name: file.name, emotion: body.emotion })) };
    else throw new Error('Unexpected mock request: ' + url);
    const code = url === '/api/stickers/status' && !enabled ? 404 : 200;
    return { ok: code === 200, status: code, json: async () => data };
  };
  class FileReader {
    readAsDataURL() { this.result = 'data:image/png;base64,eA=='; this.onload(); }
  }
  const context = vm.createContext({ document: { getElementById: (id) => ids.get(id), createElement: (tag) => new Element(tag), querySelectorAll: () => [] },
    window: { addEventListener() {} }, fetch, FileReader, setInterval: (fn) => { intervals.set(++timerId, fn); return timerId; }, clearInterval: (id) => intervals.delete(id),
    alert() { throw new Error('No delivery alerts should be used'); }, confirm: () => true, console });
  let script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  // Omit only the unrelated settings/config startup IIFE; exercise actual binding and loading helpers.
  script = script.slice(0, script.lastIndexOf('(async () => {'));
  new vm.Script(script, { filename: 'debug.html' }).runInContext(context);
  vm.runInContext('loadConfig = async () => {}; loadState = async () => {}; loadSessions = async () => {};', context);
  return { ids, calls, intervals, status, run: (code) => vm.runInContext(code, context) };
}

test('sticker UI binds once; refresh never sends and one click creates one queued job', async () => {
  const h = harness();
  await h.run('loadFeatures()');
  assert.equal(h.ids.get('stkControls').hidden, false);
  assert.equal(h.ids.get('stkUploads').children.length, 5);
  await h.ids.get('btnReload').dispatch('click');
  await h.ids.get('btnReload').dispatch('click');
  h.run('bindStickerUi()');
  assert.equal(h.calls.filter((call) => call.url === '/api/stickers/test').length, 0);
  assert.equal(h.ids.get('stkSend').listeners.get('click').length, 1);
  await h.ids.get('stkSend').dispatch('click');
  assert.equal(h.calls.filter((call) => call.url === '/api/stickers/test').length, 1);
  assert.match(h.ids.get('stkTestResult').textContent, /不代表已发送或送达/);
  assert.equal(h.intervals.size, 1);
});

test('generic config form cannot expose a second experimental master switch', () => {
  const h = harness();
  const fields = h.run("fieldsHtml({stickers:false,groupAddressGuard:true}, 'features')");
  assert.equal(fields.includes('data-path="features.stickers"'), false);
  assert.equal(fields.includes('data-path="features.groupAddressGuard"'), true);
});

test('master stays visible; on/off immediately shows controls and starts/stops status polling', async () => {
  const h = harness({ enabled: false });
  await h.run('loadFeatures()');
  assert.equal(h.ids.get('stickerCard').hidden, false);
  assert.equal(h.ids.get('stkControls').hidden, true);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.calls.some((call) => call.url === '/api/stickers/status'), false);
  const master = h.ids.get('stkMaster');
  master.checked = true; await master.dispatch('change');
  assert.equal(h.ids.get('stkControls').hidden, false);
  assert.equal(h.intervals.size, 1);
  master.checked = false; await master.dispatch('change');
  assert.equal(h.ids.get('stkControls').hidden, true);
  assert.equal(h.intervals.size, 0);
  const before = h.calls.length;
  await h.run('loadStickers()');
  await h.run('queueStickerTest()');
  assert.equal(h.calls.length, before);
});

test('poll/refresh preserves user chat and emotion, renders job data as text', async () => {
  const attack = '<img src=x onerror=alert(1)>';
  const h = harness({ jobs: [{ id: 'j', status: 'unconfirmed', filename: attack, chat: attack, error: attack }] });
  await h.run('loadFeatures()');
  h.ids.get('stkChat').value = '指定会话';
  await h.ids.get('stkChat').dispatch('input');
  h.ids.get('stkEmotion').value = 'cute';
  await h.run('loadStickers()');
  assert.equal(h.ids.get('stkChat').value, '指定会话');
  assert.equal(h.ids.get('stkEmotion').value, 'cute');
  const row = h.ids.get('stkJobs').children[0];
  assert.match(row.textContent, /未确认送达/);
  assert.equal(row.textContent.includes(attack), true);
  assert.equal(row.innerHTML, '');
});

test('upload is per emotion, uses base64 JSON, validates count/type/size, never sends', async () => {
  const h = harness();
  await h.run('loadFeatures()');
  const input = h.ids.get('stkUpload-angry');
  const button = h.ids.get('stkUploadButton-angry');
  input.files = [{ name: 'a.png', size: 1 }, { name: 'b.gif', size: 1 }];
  await button.dispatch('click');
  const uploads = h.calls.filter((call) => call.url === '/api/stickers/upload');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body.emotion, 'angry');
  assert.deepEqual(uploads[0].body.files, [{ name: 'a.png', data: 'eA==' }, { name: 'b.gif', data: 'eA==' }]);
  assert.match(h.ids.get('stkUploadResult').textContent, /未发送/);
  for (const files of [[{ name: 'bad.exe', size: 1 }], [{ name: 'big.png', size: 4 * 1024 * 1024 + 1 }], Array.from({ length: 6 }, () => ({ name: 'a.png', size: 1 }))]) {
    input.files = files; await button.dispatch('click');
  }
  assert.equal(h.calls.filter((call) => call.url === '/api/stickers/upload').length, 1);
  assert.equal(h.calls.filter((call) => call.url === '/api/stickers/test').length, 0);
});
