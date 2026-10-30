'use strict';

// No server, config, filesystem writes, or WeChat: run the debug page with a fake DOM/network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ enabled = true, jobs = [], deferFileRead = false, deferRatesSave = false, digest = null } = {}) {
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
  const config = { sticker: { chances: {cute:0.12,angry:0.2,other:0.08}, genericChance:0.25 }, persona:{ownerName:'测试主人'} };
  const status = { ok: true, enabled: true, testChat: '默认会话', dir: 'virtual/stickers', pending: 0, jobs,
    emotions: ['cute', 'angry', 'other'].map((key) => ({ key, count: 0, files: [], items: [] })) };
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || 'GET', body });
    let data;
    if (url === '/api/features' && options.method === 'POST') {
      if (body.key === 'digest') digest = body.value; else enabled = body.value;
      data = { ok: true, value: body.value };
    }
    else if (url === '/api/features') data = { ok: true, features: [{ key: 'stickers', value: enabled },
      ...(digest == null ? [] : [{ key: 'digest', label: '消息汇总', desc: '默认关闭', value: digest, everyMinutes: 30 }])] };
    else if (url === '/api/stickers/status') data = enabled ? status : { ok: false };
    else if (url === '/api/stickers/test') data = { ok: true, queued: { id: 'job-1', status: 'queued' } };
    else if (url === '/api/stickers/upload') data = { ok: true, uploaded: body.files.map((file) => ({ name: file.name, emotion: body.emotion })) };
    else if (url === '/api/stickers/delete') {
      const category = status.emotions.find((entry) => entry.key === body.emotion);
      assert.ok(category, 'delete must target one of the three categories');
      const index = category.items.findIndex((item) => item.id === body.name);
      assert.notEqual(index, -1, 'delete must carry an exact item id, not just its basename');
      category.items.splice(index, 1);
      category.files = category.items.map((item) => item.name);
      category.count = category.items.length;
      data = { ok: true, emotions: status.emotions };
    }
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
  const context = vm.createContext({ document: { getElementById: (id) => ids.get(id), createElement: (tag) => new Element(tag), querySelectorAll: () => [], querySelector: () => null },
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
  assert.equal(h.ids.get('stkUploads').children.length, 3);
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

test('digest toggle and interval share one feature row; OFF disables frequency; saving never sends', async () => {
  const h = harness({ digest: false });
  await h.run('loadFeatures()');
  const row = h.ids.get('tFeatures').children[0];
  const box = row.children[1].children[0];
  const controls = row.children[0].children[2];
  const minutes = controls.children[0].children[0];
  const save = controls.children[1];
  assert.equal(box.dataset.key, 'digest');
  assert.equal(minutes.disabled, true);
  assert.equal(save.disabled, true);
  box.checked = true; await box.dispatch('change');
  assert.equal(minutes.disabled, false);
  minutes.value = '0'; await save.click();
  assert.equal(h.calls.filter((c) => c.url === '/api/config' && c.method === 'POST').length, 0);
  minutes.value = '12'; await save.click();
  const call = h.calls.find((c) => c.url === '/api/config' && c.method === 'POST');
  assert.deepEqual(call.body, { patch: { 'digest.everyMinutes': 12 } });
  assert.equal(h.calls.some((c) => /webhook|stickers\/test|api\/digest/.test(c.url)), false);
  box.checked = false; await box.dispatch('change');
  assert.equal(minutes.disabled, true);
});

test('deleted game/queue settings stay hidden even if legacy user config retains them', () => {
  const h = harness();
  const html = h.run("fieldsHtml({ gameWhitelist:['game'], awayNotice:true, returnNotice:true, queuedMaxChats:2, queuedMaxAgeSec:300, digestMinutes:30, accountGuard:true }, 'wechat')");
  assert.doesNotMatch(html, /gameWhitelist|awayNotice|returnNotice|queuedMaxChats|queuedMaxAgeSec|digestMinutes/);
  assert.match(html, /accountGuard/);
  assert.equal(h.run("fieldsHtml({enabled:false}, 'digest')").includes('data-path="digest.enabled"'), false);
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
  const categories = [['cute','傲娇'],['angry','炸毛'],['other','其他']];
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
  const zone = h.ids.get('stkDrop-other');
  const transfer = { types: ['Files'], files: [{ name: 'x.gif', size: 20 }], items: [] };
  await zone.dispatch('drop', { dataTransfer: transfer });
  assert.equal(h.calls.some((call) => call.url === '/api/stickers/upload'), false);
  await h.run('setStickerEnabled(true)');
  for (const files of [[{ name: 'x.txt', size: 1 }], [{ name: 'huge.gif', size: 5 * 1024 * 1024 }], Array(6).fill({name:'a.gif',size:20}), []]) {
    await zone.dispatch('drop', { dataTransfer: { files, items: [] } });
  }
  await zone.dispatch('drop', { dataTransfer: { files: transfer.files, items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }] } });
  assert.match(h.ids.get('stkUploadState-other').textContent, /不要拖入文件夹/);
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
  const { loadConfig } = require('../src/infra/config');
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
  for (const field of ['sticker.chances.cute','sticker.chances.angry','sticker.chances.other']) {
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

test('probabilities are visible as percentages under all three drop cards; editing never opens file picker', async () => {
  const h = harness(); await h.run('loadFeatures()');
  for (const [key, percent] of [['cute',12],['angry',20],['other',8]]) {
    const input = h.ids.get('stkChance-' + key);
    assert.equal(Number(input.value), percent);
    assert.equal(input.disabled, false);
    assert.equal(input.type, 'number');
    await h.ids.get('stkDrop-' + key).dispatch('click', { target: input });
    assert.equal(h.ids.get('stkUpload-' + key).clicks || 0, 0, '不能把改概率当选图');
  }
  assert.equal(h.ids.get('stkSaveRates').disabled, true);
  const generic = h.run("fieldsHtml({chances:{cute:0.12,angry:0.2,other:0.08},cooldownMinutes:10},'sticker')");
  for (const key of ['cute','angry','other']) {
    assert.equal(generic.includes('data-path="sticker.chances.' + key + '"'), false, '不要出现两份概率控件');
  }
});

test('percentage save sends only the three probabilities, never toggles feature or sends a message', async () => {
  const h = harness(); await h.run('loadFeatures()');
  const chance = h.ids.get('stkChance-angry'); chance.value = '12.5'; await chance.dispatch('input');
  h.ids.get('stkChance-other').value = '0'; await h.ids.get('stkChance-other').dispatch('input');
  await h.ids.get('stkSaveRates').dispatch('click');
  const writes = h.calls.filter(c => c.url === '/api/config' && c.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.patch, {
    'sticker.chances.cute':0.12,'sticker.chances.angry':0.125,'sticker.chances.other':0,
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

function elementText(element) {
  return [element.textContent, ...element.children.map(elementText)].join('');
}

function setCategoryItems(h, key, items) {
  const category = h.status.emotions.find((entry) => entry.key === key);
  category.items = items;
  category.files = items.map((item) => item.name);
  category.count = items.length;
}

test('console has only 傲娇/炸毛/其他 in that order and places the other-pool explanation beside its title', async () => {
  const h = harness(); await h.run('loadFeatures()');
  assert.deepEqual(h.ids.get('stkUploads').children.map((zone) => zone.id), ['stkDrop-cute','stkDrop-angry','stkDrop-other']);
  assert.deepEqual(h.ids.get('stkEmotion').children.map((option) => option.value), ['cute','angry','other']);
  const titles = h.ids.get('stkUploads').children.map((zone) => elementText(zone.children.find((child) => child.tagName === 'H4')));
  assert.match(titles[0], /^傲娇/);
  assert.match(titles[1], /^炸毛/);
  assert.match(titles[2], /^其他[（(]此为绝大部分情绪，建议多加表情包[）)]$/);
  for (const key of ['happy','meh','bored']) {
    assert.equal(h.ids.has('stkDrop-' + key), false);
    assert.equal(h.ids.has('stkOption-' + key), false);
  }
  for (const key of ['cute','angry','other']) {
    delete h.config.sticker.chances[key];
  }
  delete h.config.sticker.genericChance;
  await h.run('loadStickerRates()');
  for (const key of ['cute','angry','other']) assert.equal(Number(h.ids.get('stkChance-' + key).value), 25);
  assert.equal(h.calls.some((call) => call.url === '/api/stickers/upload' || call.url === '/api/stickers/test'), false);
});

test('deleting a thumbnail stops bubbling and never opens a picker, uploads or sends', async () => {
  const h = harness();
  setCategoryItems(h, 'cute', [{ name:'抱抱.gif', id:'傲娇/抱抱.gif' }]);
  await h.run('loadFeatures()');
  const button = h.ids.get('stkThumbs-cute').children[0].children.find((child) => child.tagName === 'BUTTON');
  const event = await button.dispatch('click');
  assert.equal(event.propagationStopped, true);
  await h.ids.get('stkDrop-cute').dispatch('click', { target:button });
  // The real click listener starts an async delete without returning its promise.
  await new Promise((resolve) => setImmediate(resolve));
  const deletes = h.calls.filter((call) => call.url === '/api/stickers/delete');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].body.emotion, 'cute');
  assert.equal(deletes[0].body.name, '傲娇/抱抱.gif');
  assert.equal(h.status.emotions.find((entry) => entry.key === 'cute').count, 0);
  assert.equal(h.ids.get('stkThumbs-cute').children.length, 0);
  for (const key of ['cute','angry','other']) assert.equal(h.ids.get('stkUpload-' + key).clicks || 0, 0);
  assert.equal(h.calls.some((call) => call.url === '/api/stickers/upload' || call.url === '/api/stickers/test'), false);
});

test('duplicate basenames retain distinct preview and delete ids from current and legacy folders', async () => {
  const h = harness();
  const items = [{name:'同名.gif',id:'其他/同名.gif'},{name:'同名.gif',id:'开心/同名.gif'}];
  setCategoryItems(h, 'other', items.map((item) => ({...item})));
  await h.run('loadFeatures()');
  const thumbnails = h.ids.get('stkThumbs-other').children;
  assert.equal(thumbnails.length, 2, 'do not deduplicate entries by basename');
  for (let index = 0; index < items.length; index++) {
    const image = thumbnails[index].children.find((child) => child.tagName === 'IMG');
    const query = new URL(image.src, 'http://mock.invalid').searchParams;
    assert.equal(query.get('emotion'), 'other');
    assert.equal(query.get('name'), items[index].id);
  }
  const legacyDelete = thumbnails[1].children.find((child) => child.tagName === 'BUTTON');
  await legacyDelete.dispatch('click');
  // Let the listener's own delete-and-refresh chain settle before asserting the DOM.
  await new Promise((resolve) => setImmediate(resolve));
  const deletes = h.calls.filter((call) => call.url === '/api/stickers/delete');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].body.name, '开心/同名.gif');
  assert.deepEqual(h.status.emotions.find((entry) => entry.key === 'other').items, [items[0]], 'deleting the legacy entry must preserve the canonical same-name file');
  const remaining = h.ids.get('stkThumbs-other').children;
  assert.equal(remaining.length, 1);
  const image = remaining[0].children.find((child) => child.tagName === 'IMG');
  assert.equal(new URL(image.src, 'http://mock.invalid').searchParams.get('name'), '其他/同名.gif');
  assert.equal(h.calls.some((call) => call.url === '/api/stickers/upload' || call.url === '/api/stickers/test'), false);
});

test('other probability falls back to genericChance, saves chances.other and survives reload', async () => {
  const h = harness();
  delete h.config.sticker.chances.other;
  h.config.sticker.genericChance = 0.37;
  await h.run('loadFeatures()');
  const other = h.ids.get('stkChance-other');
  assert.equal(Number(other.value), 37);
  other.value = '16.5'; await other.dispatch('input');
  await h.ids.get('stkSaveRates').dispatch('click');
  const writes = h.calls.filter((call) => call.url === '/api/config' && call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.patch, {'sticker.chances.cute':0.12,'sticker.chances.angry':0.2,'sticker.chances.other':0.165});
  assert.equal(h.config.sticker.chances.other, 0.165);
  assert.equal(h.config.sticker.genericChance, 0.37, 'save must not overwrite unrelated legacy configuration');
  await h.run('loadStickerRates()');
  assert.equal(Number(other.value), 16.5, 'explicit chances.other must take precedence over genericChance');
  h.config.sticker.chances.other = 0;
  await h.run('loadStickerRates()');
  assert.equal(Number(other.value), 0, 'zero is an explicit rate, not a missing value');
  assert.equal(h.calls.some((call) => call.url === '/api/stickers/upload' || call.url === '/api/stickers/test' || (call.url === '/api/features' && call.method === 'POST')), false);
});
