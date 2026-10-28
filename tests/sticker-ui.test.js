'use strict';

// No server, config, filesystem writes, or WeChat: run the debug page with a fake DOM/network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ enabled = true, jobs = [], deferFileRead = false, deferRatesSave = false } = {}) {
  const ids = new Map();
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = new Map();
      this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
      this.textContent = ''; this.dataset = {}; this.style = {}; this.files = []; this.attributes = {};
      const classes = new Set();
      this.classList = { add: (v) => classes.add(v), remove: (v) => classes.delete(v), contains: (v) => classes.has(v) };
    }
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id; }
    set innerHTML(value) { this._html = value; this.children = []; }
    get innerHTML() { return this._html || ''; }
    appendChild(child) { this.children.push(child); if (this.tagName === 'SELECT' && this.children.length === 1) this.value = child.value; return child; }
    replaceChildren(...children) { this.children = children; }
    addEventListener(event, fn) { const list = this.listeners.get(event) || []; list.push(fn); this.listeners.set(event, list); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    click() { this.clicks = (this.clicks || 0) + 1; return this.dispatch('click'); }
    async dispatch(name, init = {}) {
      const event = { target: this, defaultPrevented: false, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...init };
      await Promise.all((this.listeners.get(name) || []).map((fn) => fn(event)));
      return event;
    }
  }
  const html = fs.readFileSync(path.join(__dirname, '../web/debug.html'), 'utf8');
  for (const [, tag, id] of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) { const element = new Element(tag); element.id = id; }
  ids.get('stkControls').hidden = true;
  ids.get('stkChat').value = '文件传输助手';
  const calls = []; const intervals = new Map(); let timerId = 0;
  const saves = [];
  const config = { sticker: { chances: {happy:0.1,angry:0.2,cute:0.12,meh:0.08,bored:0.06}, cooldownMinutes:10 }, persona:{ownerName:'测试主人'} };
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
    else if (url === '/api/config') {
      if (options.method === 'POST') for (const [key,value] of Object.entries(body.patch)) {
        const parts = key.split('.'); let current = config;
        for (const part of parts.slice(0,-1)) current = current[part] ||= {};
        current[parts.at(-1)] = value;
      }
      data = {ok:true,config:JSON.parse(JSON.stringify(config))};
      if (options.method === 'POST' && deferRatesSave) await new Promise((resolve) => saves.push(resolve));
    }
    else throw new Error('Unexpected mock request: ' + url);
    const code = url === '/api/stickers/status' && !enabled ? 404 : 200;
    return { ok: code === 200, status: code, json: async () => data };
  };
  const reads = [];
  class FileReader {
    readAsDataURL() {
      this.result = 'data:image/png;base64,eA==';
      if (deferFileRead) reads.push(() => this.onload()); else this.onload();
    }
  }
  const mockWindow = new Element('window');
  const context = vm.createContext({ document: { getElementById: (id) => ids.get(id), createElement: (tag) => new Element(tag), querySelectorAll: () => [] },
    window: mockWindow, fetch, FileReader, setInterval: (fn) => { intervals.set(++timerId, fn); return timerId; }, clearInterval: (id) => intervals.delete(id),
    alert() { throw new Error('No delivery alerts should be used'); }, confirm: () => true, console });
  let script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  // Omit only the unrelated settings/config startup IIFE; exercise actual binding and loading helpers.
  script = script.slice(0, script.lastIndexOf('(async () => {'));
  new vm.Script(script, { filename: 'debug.html' }).runInContext(context);
  vm.runInContext('loadConfig = async () => {}; loadState = async () => {}; loadSessions = async () => {};', context);
  return { ids, calls, intervals, status, mockWindow, config, finishSaves: () => saves.splice(0).forEach((finish) => finish()), finishReads: () => reads.splice(0).forEach((finish) => finish()), run: (code) => vm.runInContext(code, context) };
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
  assert.equal(input.clicks, 1, '中文按钮打开选择窗口，选完自动上传');
  await input.dispatch('change');
  const uploads = h.calls.filter((call) => call.url === '/api/stickers/upload');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body.emotion, 'angry');
  assert.deepEqual(uploads[0].body.files, [{ name: 'a.png', data: 'eA==' }, { name: 'b.gif', data: 'eA==' }]);
  assert.match(h.ids.get('stkUploadResult').textContent, /未发送/);
  for (const files of [[{ name: 'bad.exe', size: 1 }], [{ name: 'big.png', size: 4 * 1024 * 1024 + 1 }], Array.from({ length: 6 }, () => ({ name: 'a.png', size: 1 }))]) {
    input.files = files; await input.dispatch('change');
  }
  assert.equal(h.calls.filter((call) => call.url === '/api/stickers/upload').length, 1);
  assert.equal(h.calls.filter((call) => call.url === '/api/stickers/test').length, 0);
});

test('dragging files into each Chinese category automatically saves only to that category', async () => {
  const h = harness();
  await h.run('loadFeatures()');
  const categories = [['happy','开心'],['angry','炸毛'],['cute','撒娇'],['meh','嫌弃'],['bored','敷衍']];
  for (const [key, label] of categories) {
    const zone = h.ids.get('stkDrop-' + key);
    assert.match(zone.getAttribute('aria-label'), new RegExp(label));
    const transfer = { types: ['Files'], files: [{ name: '动画.gif', size: 20 }], items: [] };
    const over = await zone.dispatch('dragover', { dataTransfer: transfer });
    assert.equal(over.defaultPrevented, true);
    assert.equal(transfer.dropEffect, 'copy');
    assert.equal(zone.classList.contains('dragging'), true);
    const before = h.calls.filter((c) => c.url === '/api/stickers/upload').length;
    const drop = await zone.dispatch('drop', { dataTransfer: transfer });
    assert.equal(drop.defaultPrevented, true);
    assert.equal(drop.propagationStopped, true);
    assert.equal(zone.classList.contains('dragging'), false);
    const uploads = h.calls.filter((c) => c.url === '/api/stickers/upload');
    assert.equal(uploads.length, before + 1);
    assert.equal(uploads.at(-1).body.emotion, key);
    assert.equal(uploads.at(-1).body.files[0].name, '动画.gif');
    assert.match(h.ids.get('stkUploadState-' + key).textContent, new RegExp(label + '.*已保存'));
  }
  assert.equal(h.calls.some((call) => call.url === '/api/stickers/test'), false);
});

test('drag-drop off, invalid files, folders and outside category cannot upload or navigate', async () => {
  const h = harness({ enabled: false });
  await h.run('loadFeatures()');
  const zone = h.ids.get('stkDrop-happy');
  const transfer = { types: ['Files'], files: [{ name: 'x.gif', size: 20 }], items: [] };
  await zone.dispatch('drop', { dataTransfer: transfer });
  assert.equal(h.calls.some((call) => call.url === '/api/stickers/upload'), false);
  await h.run('setStickerEnabled(true)');
  for (const files of [[{ name: 'x.txt', size: 1 }], [{ name: 'huge.gif', size: 5 * 1024 * 1024 }], Array(6).fill({name:'a.gif',size:20}), []]) {
    await zone.dispatch('drop', { dataTransfer: { files, items: [] } });
  }
  await zone.dispatch('drop', { dataTransfer: { files: transfer.files, items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }] } });
  assert.match(h.ids.get('stkUploadState-happy').textContent, /不要拖入文件夹/);
  const outside = await h.mockWindow.dispatch('drop', { dataTransfer: transfer });
  assert.equal(outside.defaultPrevented, true);
  assert.match(h.ids.get('stkUploadResult').textContent, /对应情绪框/);
  assert.equal(h.calls.some((call) => call.url === '/api/stickers/upload'), false);
});

test('same category cannot double-upload while reading and off/on cancels an older drop', async () => {
  const h = harness({ deferFileRead: true });
  await h.run('loadFeatures()');
  const zone = h.ids.get('stkDrop-cute');
  const transfer = { files: [{name:'a.gif',size:20}], items: [] };
  const pending = zone.dispatch('drop', { dataTransfer: transfer });
  assert.equal(zone.getAttribute('aria-busy'), 'true');
  await zone.dispatch('drop', { dataTransfer: transfer });
  assert.match(h.ids.get('stkUploadState-cute').textContent, /正在上传/);
  await h.run('setStickerEnabled(false);setStickerEnabled(true)');
  h.finishReads(); await pending;
  assert.equal(h.calls.some((call) => call.url === '/api/stickers/upload'), false);
  assert.equal(zone.getAttribute('aria-busy'), 'false');
  assert.match(h.ids.get('stkUploadState-cute').textContent, /取消/);
});

test('console field labels and group headings cover all current defaults in Chinese', () => {
  const h = harness();
  const { loadConfig } = require('../src/config');
  const config = loadConfig({ root: path.join(__dirname, '__nonexistent_label_fixture__'), env: {} });
  const skipTop = new Set(['paths','env','root','configExists']);
  const excluded = new Set(['features.stickers','sticker.enabled','sticker.maxSide']);
  const jsonFields = new Set(['gateway.wechat.outboundHeaders','gateway.douyin.outboundHeaders']);
  function visit(obj, prefix = '') {
    for (const [key,value] of Object.entries(obj)) {
      if (key.startsWith('_') || (!prefix && skipTop.has(key))) continue;
      const field = prefix ? prefix + '.' + key : key;
      if (excluded.has(field)) continue;
      if (!prefix && value && typeof value === 'object' && !Array.isArray(value)) {
        assert.match(h.run('SECTION_TITLES[' + JSON.stringify(field) + ']') || '', /[\u4e00-\u9fff]/, field);
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && !jsonFields.has(field)) {
        if (prefix) assert.match(h.run('(META[' + JSON.stringify(field) + ']||[])[0]') || '', /[\u4e00-\u9fff]/, field);
        visit(value, field);
      } else assert.match(h.run('(META[' + JSON.stringify(field) + ']||[])[0]') || '', /[\u4e00-\u9fff]/, field);
    }
  }
  visit(config);
  for (const field of ['sticker.chances.happy','sticker.chances.angry','sticker.chances.cute','sticker.chances.meh','sticker.chances.bored']) {
    const label = h.run('(META[' + JSON.stringify(field) + ']||[])[0]');
    assert.equal(/[A-Za-z]/.test(label), false);
  }
});

test('English bridge failures and reserved state are displayed as Chinese without exposing task codes', async () => {
  const h = harness({ jobs: [
    {id:'technical-uuid',status:'reserved',chat:'文件传输助手',filename:'动图.gif'},
    {id:'other-uuid',status:'failed',chat:'文件传输助手',filename:'动图.gif',error:'target account window could not be verified'},
    {id:'third',status:'unconfirmed',chat:'文件传输助手',filename:'动图.gif',error:'no new outgoing media message confirmed; do not retry'},
  ] });
  await h.run('loadFeatures()');
  const text = h.ids.get('stkJobs').children.map((child) => child.textContent).join('\n');
  assert.match(text, /等待文字回复完成/);
  assert.match(text, /无法确认当前微信账号/);
  assert.match(text, /不要重复发送/);
  assert.equal(/reserved|account|retry|uuid/.test(text), false);
  assert.equal(h.ids.get('stkStatus').textContent.includes('virtual/stickers'), false);
});

test('probabilities are visible as percentages under all five drop cards; editing never opens file picker', async () => {
  const h = harness(); await h.run('loadFeatures()');
  for (const [key, percent] of [['happy',10],['angry',20],['cute',12],['meh',8],['bored',6]]) {
    const input = h.ids.get('stkChance-' + key);
    assert.equal(Number(input.value), percent);
    assert.equal(input.disabled, false);
    assert.equal(input.type, 'number');
    await h.ids.get('stkDrop-' + key).dispatch('click', { target: input });
    assert.equal(h.ids.get('stkUpload-' + key).clicks || 0, 0, '不能把改概率当选图');
  }
  assert.equal(h.ids.get('stkSaveRates').disabled, true);
  const generic = h.run("fieldsHtml({chances:{happy:0.1},cooldownMinutes:10},'sticker')");
  assert.equal(generic.includes('data-path="sticker.chances.happy"'), false, '不要出现两份概率控件');
});

test('percentage save sends only the five probabilities, never toggles feature or sends a message', async () => {
  const h = harness(); await h.run('loadFeatures()');
  const chance = h.ids.get('stkChance-angry'); chance.value = '12.5'; await chance.dispatch('input');
  h.ids.get('stkChance-happy').value = '0'; await h.ids.get('stkChance-happy').dispatch('input');
  await h.ids.get('stkSaveRates').dispatch('click');
  const writes = h.calls.filter(c => c.url === '/api/config' && c.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.patch, {
    'sticker.chances.happy':0,'sticker.chances.angry':0.125,'sticker.chances.cute':0.12,
    'sticker.chances.meh':0.08,'sticker.chances.bored':0.06,
  });
  assert.equal(h.ids.get('stkCooldown'), undefined, '不应再有发送间隔控件');
  assert.equal(h.config.persona.ownerName, '测试主人');
  assert.equal(h.calls.some(c => c.url === '/api/stickers/test' || (c.url === '/api/features' && c.method === 'POST')), false);
  assert.match(h.ids.get('stkRatesStatus').textContent, /已保存/);
});

test('refresh preserves unsaved probabilities and invalid percentages cannot be saved', async () => {
  const h = harness(); await h.run('loadFeatures()');
  const input = h.ids.get('stkChance-angry');
  input.value = '30'; await input.dispatch('input');
  await h.run('loadFeatures()');
  assert.equal(input.value, '30');
  for (const invalid of ['-1','101','','not-a-number']) {
    input.value = invalid; await input.dispatch('input');
    await h.run('saveStickerRates()');
    assert.match(h.ids.get('stkRatesStatus').textContent, /零到一百/);
  }
  assert.equal(h.calls.some(c => c.url === '/api/config' && c.method === 'POST'), false);
  await h.run('setStickerEnabled(false)');
  input.value = '20'; await input.dispatch('input'); await h.run('saveStickerRates()');
  assert.equal(h.calls.some(c => c.url === '/api/config' && c.method === 'POST'), false);
});

test('edits made during a save remain marked unsaved instead of being overwritten', async () => {
  const h = harness({ deferRatesSave: true }); await h.run('loadFeatures()');
  const input = h.ids.get('stkChance-angry'); input.value = '15'; await input.dispatch('input');
  const saving = h.run('saveStickerRates()');
  input.value = '25'; await input.dispatch('input');
  h.finishSaves(); await saving;
  assert.equal(input.value, '25');
  assert.equal(h.ids.get('stkSaveRates').disabled, false);
  assert.match(h.ids.get('stkRatesStatus').textContent, /还未保存/);
  assert.equal(h.config.sticker.chances.angry, 0.15);
});
