'use strict';

/* =========================================================
   鲸鲸 · 前端逻辑（原生 JS，无依赖）
   ========================================================= */

const $ = (id) => document.getElementById(id);
const chatEl = $('chat');
const inputEl = $('input');
const sendBtn = $('send');
const typingEl = $('typing');

const GROUP_MEMBERS = [
  { name: '阿螈', emoji: '🐟' },
  { name: '海胆酱', emoji: '🦔' },
  { name: '小丑鱼', emoji: '🐠' },
  { name: '你自己', emoji: '🙋' },
];

const state = {
  sessionId: localStorage.getItem('whale.sessionId') || '',
  mode: localStorage.getItem('whale.mode') || 'private',
  userName: localStorage.getItem('whale.userName') || '',
  streaming: false,
  status: null,
  settings: null,
};

if (!state.sessionId) {
  state.sessionId = 'w' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  localStorage.setItem('whale.sessionId', state.sessionId);
}

/* ---------------- 背景气泡 ---------------- */
function makeBubbles() {
  const host = $('bubbles');
  if (!host) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 26; i++) {
    const b = document.createElement('span');
    const size = 4 + Math.random() * 16;
    b.style.width = b.style.height = size + 'px';
    b.style.left = Math.random() * 100 + '%';
    b.style.animationDuration = 12 + Math.random() * 20 + 's';
    b.style.animationDelay = -Math.random() * 26 + 's';
    b.style.setProperty('--drift', Math.round((Math.random() - 0.5) * 90) + 'px');
    b.style.opacity = String(0.2 + Math.random() * 0.5);
    frag.appendChild(b);
  }
  host.appendChild(frag);
}

/* ---------------- 工具 ---------------- */
function nowLabel(d = new Date()) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function scrollToBottom(smooth = true) {
  chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function toast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function escapeTime(ts) {
  const d = new Date(ts || Date.now());
  return isNaN(d.getTime()) ? '' : nowLabel(d);
}

function memberEmoji(name) {
  const m = GROUP_MEMBERS.find((x) => x.name === name);
  return m ? m.emoji : (name || '你').slice(0, 1);
}

/* ---------------- 消息渲染 ---------------- */
function addMessage({ role, name, text, time, error, caret }) {
  if (role === 'system') {
    const line = document.createElement('div');
    line.className = 'system-line';
    line.textContent = text;
    chatEl.appendChild(line);
    scrollToBottom();
    return line;
  }

  const row = document.createElement('div');
  row.className = 'msg ' + (role === 'bot' ? 'bot' : 'user');

  const avatar = document.createElement('div');
  avatar.className = 'mini-avatar';
  if (role === 'bot') {
    const img = document.createElement('img');
    img.src = '/assets/avatar.jpg';
    img.alt = '';
    img.style.cssText = 'width:100%;height:100%;border-radius:50%;display:block';
    avatar.appendChild(img);
  } else {
    avatar.textContent = memberEmoji(name);
  }
  avatar.style.display = 'grid';
  avatar.style.placeItems = 'center';
  avatar.style.fontSize = '14px';

  const body = document.createElement('div');
  body.className = 'body';

  const nameEl = document.createElement('div');
  nameEl.className = 'name';
  nameEl.textContent = role === 'bot' ? '鲸鲸' : name || '你';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (error) bubble.style.borderColor = 'rgba(255,120,140,.45)';
  const textNode = document.createElement('span');
  textNode.className = 'bubble-text';
  textNode.textContent = text || '';
  bubble.appendChild(textNode);

  let caretEl = null;
  if (caret) {
    caretEl = document.createElement('span');
    caretEl.className = 'caret';
    bubble.appendChild(caretEl);
  }

  const timeEl = document.createElement('div');
  timeEl.className = 'time';
  timeEl.textContent = time || nowLabel();

  body.appendChild(nameEl);
  body.appendChild(bubble);
  body.appendChild(timeEl);
  row.appendChild(avatar);
  row.appendChild(body);
  chatEl.appendChild(row);
  scrollToBottom();
  return { row, bubble, textNode, caretEl };
}

function setText(node, text) {
  node.textContent = text;
}

/** 把一条长回复拆成几条气泡（更接近真实群聊） */
function expandBubbles(msgEl, bubbles) {
  if (!bubbles || bubbles.length <= 1) return;
  msgEl.row.remove();
  let delay = 0;
  for (const b of bubbles) {
    setTimeout(() => {
      addMessage({ role: 'bot', text: b, time: nowLabel() });
    }, delay);
    delay += 260;
  }
}

function showTyping(show) {
  typingEl.hidden = !show;
  if (show) scrollToBottom();
}

/* ---------------- 状态刷新 ---------------- */
async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    state.status = data;
    const dot = $('dot');
    dot.className = 'dot';
    // 把版本号显示出来：以前网页上完全看不到版本，装了新旧包分不清
    if ($('buildVersion')) $('buildVersion').textContent = data.version ? ` · v${data.version}` : '';
    if (data.mock) dot.classList.add('mock');
    if (data.mock) {
      $('statusText').textContent = '演示模式 · 内置台词';
    } else {
      $('statusText').textContent = `${data.providerLabel || '模型'} · ${data.model} · 在线`;
    }
    $('hint').textContent = data.mock
      ? data.hasKey
        ? '⚠️ 已保存 API Key，但「演示模式」开着，现在只会说内置台词。去设置里关掉它，就是真模型了。'
        : '演示模式：还没配置模型，用的是内置台词。点右上角「设置」选一个免费模型（智谱 GLM-4-Flash / 本地 Ollama）就能真聊。'
      : `已接入 ${data.providerLabel || '模型'}（${data.model}）。记忆存在本机，共 ${data.memory.sessions} 个聊天。`;
    const gws = data.gateways || [];
    $('gatewayState').textContent = gws
      .map((g) => {
        if (!g.enabled) return `${g.platform}：未启用`;
        if (g.outboundConfigured) {
          return `${g.platform}：中转网关已配置${g.received ? ` · 收到 ${g.received} 条` : ''}`;
        }
        const b = g.bridge || {};
        const got = g.received ? ` · 收到 ${g.received} 条` : '';
        if (!b.online) {
          return `${g.platform}：桥接离线 ← 微信里收不到回复（要另开「启动微信桥接.bat」）`;
        }
        const state = b.rest
          ? '游戏运行中 · 休息模式（回复先排队）'
          : b.listener === false
            ? '收消息线程已停（微信里发消息不会进来，重启桥接）'
            : b.uia === false
              ? 'UIA 不可用（消息发不出去，看桥接窗口报错）'
              : b.uia === null
                ? '状态未知（等预热）'
                : 'UIA 正常';
        return `${g.platform}：桥接在线 · ${state}${got}`;
      })
      .join('　｜　');
    updateWebhookCodes();
  } catch (err) {
    $('dot').className = 'dot off';
    $('statusText').textContent = '连不上本地服务…';
  }
}

function updateWebhookCodes() {
  const origin = location.origin;
  $('whWechat').textContent = origin + '/webhook/wechat';
  $('whDouyin').textContent = origin + '/webhook/douyin';
}

/* ---------------- 模式 / 快捷按钮 ---------------- */
const CHIPS = {
  private: [
    { t: '你是谁呀' },
    { t: '讲个冷笑话' },
    { t: '深海小知识' },
    { t: '安慰我一下' },
    { t: '晚安' },
  ],
  group: [
    { t: '在吗', at: true },
    { t: '今天加班好累啊' },
    { t: '哈哈哈哈哈哈' },
    { t: '鲸鲸你说呢' },
    { t: '晚上吃啥' },
  ],
};

function renderChips() {
  const host = $('chips');
  host.textContent = '';
  for (const c of CHIPS[state.mode]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = c.at ? '@鲸鲸 ' + c.t : c.t;
    btn.addEventListener('click', () => {
      if (state.mode === 'group') {
        sendMessage(c.at ? '@鲸鲸 ' + c.t : c.t);
      } else {
        sendMessage(c.t);
      }
    });
    host.appendChild(btn);
  }
}

function applyMode() {
  const isGroup = state.mode === 'group';
  $('groupBar').hidden = !isGroup;
  $('senderSel').hidden = !isGroup;
  $('btnAt').hidden = !isGroup;
  $('btnMode').classList.toggle('active', isGroup);
  $('btnMode').querySelector('em').textContent = isGroup ? '私聊' : '群聊';
  inputEl.placeholder = isGroup
    ? '以群友身份说点什么…（打「鲸鲸」或点 @ 才会被接话）'
    : '跟鲸鲸说点什么…（Enter 发送 / Shift+Enter 换行）';
  renderChips();
}

/* ---------------- 发送 ---------------- */
async function sendMessage(rawText) {
  if (state.streaming) return;
  const text = String(rawText ?? inputEl.value).trim();
  if (!text) return;
  if (rawText === undefined) {
    inputEl.value = '';
    autoGrow();
  }

  const isGroup = state.mode === 'group';
  const senderName = isGroup ? $('senderSel').value : state.userName || '你';
  addMessage({ role: 'user', name: senderName, text });
  showTyping(true);
  state.streaming = true;
  sendBtn.disabled = true;

  let streamMsg = null;
  let full = '';
  let gotAny = false;

  const payload = {
    text,
    mode: state.mode,
    sessionId: state.sessionId,
    senderName,
    msgId: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const ct = res.headers.get('content-type') || '';

    if (!ct.includes('text/event-stream')) {
      const data = await res.json().catch(() => ({}));
      showTyping(false);
      if (data.action === 'ignore') {
        addMessage({ role: 'system', text: ignoreReasonText(data.reason) });
      } else if (data.error) {
        addMessage({ role: 'bot', text: data.error, error: true });
      }
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    const handleEvent = (evt) => {
      if (evt.type === 'meta') {
        gotAny = true;
        return;
      }
      if (evt.type === 'delta') {
        if (!streamMsg) {
          showTyping(false);
          streamMsg = addMessage({ role: 'bot', text: '', caret: true });
        }
        full += evt.text || '';
        setText(streamMsg.textNode, full);
        scrollToBottom(false);
        return;
      }
      if (evt.type === 'done') {
        if (!streamMsg) {
          showTyping(false);
          streamMsg = addMessage({ role: 'bot', text: evt.text || full, error: evt.error });
        } else {
          if (streamMsg.caretEl) streamMsg.caretEl.remove();
          setText(streamMsg.textNode, evt.text || full);
        }
        if (evt.error) {
          streamMsg.bubble.style.borderColor = 'rgba(255,120,140,.45)';
          toast('DeepSeek 没接上，先看看控制台日志或检查 API Key');
        }
        if (evt.bubbles && evt.bubbles.length > 1 && !evt.error) {
          expandBubbles(streamMsg, evt.bubbles);
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            handleEvent(JSON.parse(line.slice(5).trim()));
          } catch {
            /* ignore malformed */
          }
        }
      }
    }

    if (!gotAny && !full) {
      showTyping(false);
      addMessage({ role: 'system', text: '（鲸鲸没有回应，可能是网络或接口问题）' });
    }
  } catch (err) {
    showTyping(false);
    addMessage({ role: 'system', text: '（连不上本地服务，确认 server 还开着：node server.js）' });
    console.error(err);
  } finally {
    state.streaming = false;
    sendBtn.disabled = false;
    showTyping(false);
    if (streamMsg && streamMsg.caretEl) streamMsg.caretEl.remove();
    setTimeout(() => scrollToBottom(false), 60);
  }
}

function ignoreReasonText(reason) {
  const map = {
    not_addressed: '（鲸鲸没被叫到，只在旁边冒了个泡）',
    duplicate: '（重复消息，鲸鲸跳过了）',
    muted: '（鲸鲸闭麦中…@ 她试试）',
    cooldown: '（鲸鲸刚说完，先歇一下）',
    rate_limited: '（鲸鲸今天话有点多，先歇一下）',
    no_text: '（没有文字内容）',
  };
  return map[reason] || `（鲸鲸没有接话：${reason}）`;
}

/* ---------------- 群友自动串门 ---------------- */
const AUTO_SCRIPT = [
  { from: '阿螈', text: '今天加班到十点，人已经麻了' },
  { from: '海胆酱', text: '@鲸鲸 你说人为什么要上班啊', at: true },
  { from: '小丑鱼', text: '哈哈哈哈哈哈哈' },
  { from: '阿螈', text: '鲸鲸，安慰我一下' },
];

let autoRunning = false;
async function runAutoGroup() {
  if (autoRunning || state.streaming) return;
  autoRunning = true;
  const btn = $('btnAutoGroup');
  btn.disabled = true;
  for (const step of AUTO_SCRIPT) {
    $('senderSel').value = step.from;
    await streamForGroup(step.text, step.from);
    await new Promise((r) => setTimeout(r, 700));
  }
  btn.disabled = false;
  autoRunning = false;
}

async function streamForGroup(text, sender) {
  // 复用 sendMessage 的渲染与流式逻辑，但固定发送者
  const prevMode = state.mode;
  state.mode = 'group';
  const prevVal = $('senderSel').value;
  $('senderSel').value = sender;
  const isAt = /^@/.test(text);
  if (!isAt) {
    // 非 @ 消息也走一次接口，让鲸鲸"旁听"（会被忽略）
    const payload = {
      text,
      mode: 'group',
      sessionId: state.sessionId,
      senderName: sender,
      msgId: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    };
    addMessage({ role: 'user', name: sender, text });
    showTyping(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/event-stream')) {
        const data = await res.json().catch(() => ({}));
        showTyping(false);
        if (data.action === 'ignore') addMessage({ role: 'system', text: ignoreReasonText(data.reason) });
      } else {
        // 少见：随机接话，直接读取完整流
        showTyping(false);
        await consumeStreamSimple(res);
      }
    } catch {
      showTyping(false);
    }
    state.mode = prevMode;
    $('senderSel').value = prevVal;
    return;
  }
  await sendMessage(text);
  state.mode = prevMode;
  $('senderSel').value = prevVal;
}

async function consumeStreamSimple(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let msg = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (evt.type === 'delta') {
          if (!msg) msg = addMessage({ role: 'bot', text: '', caret: true });
          full += evt.text || '';
          setText(msg.textNode, full);
          scrollToBottom(false);
        } else if (evt.type === 'done') {
          if (!msg) msg = addMessage({ role: 'bot', text: evt.text || full });
          else {
            if (msg.caretEl) msg.caretEl.remove();
            setText(msg.textNode, evt.text || full);
          }
          if (evt.bubbles && evt.bubbles.length > 1) expandBubbles(msg, evt.bubbles);
        }
      }
    }
  }
}

/* ---------------- 设置 ---------------- */
function providerMeta() {
  return (state.settings && state.settings.providers) || {};
}

function fillProviderFields(provider, { keepValues = false } = {}) {
  const meta = providerMeta()[provider] || {};
  $('providerHint').textContent = meta.hint || '';
  const list = $('modelList');
  list.textContent = '';
  for (const m of meta.models || []) {
    const opt = document.createElement('option');
    opt.value = m;
    list.appendChild(opt);
  }
  if (!keepValues) {
    $('baseUrl').value = meta.baseUrl || '';
    $('model').value = meta.model || '';
  }
  const needsKey = meta.needsKey !== false;
  $('apiKey').placeholder = needsKey ? 'sk-…（这个服务需要 Key）' : '本地模型不需要 Key，留空即可';
  $('keyState').textContent = !needsKey
    ? '（不需要）'
    : state.settings && state.settings.hasKey
      ? '已保存 ' + state.settings.keyMasked
      : '';
}

async function openSettings() {
  $('settingsModal').hidden = false;
  $('userName').value = state.userName || '';
  $('testResult').textContent = '';
  $('testResult').className = 'test-result';
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    state.settings = data;
    // 称呼保存在服务端 data/settings.json（以前只存浏览器里，换设备/清缓存就没了）
    if (data.userName) {
      state.userName = data.userName;
      $('userName').value = data.userName;
    }
    const sel = $('provider');
    sel.textContent = '';
    for (const [key, meta] of Object.entries(data.providers || {})) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = meta.label || key;
      sel.appendChild(opt);
    }
    sel.value = data.provider || 'deepseek';
    $('baseUrl').value = data.baseUrl || '';
    $('model').value = data.model || '';
    fillProviderFields(sel.value, { keepValues: true });
    $('keyState').textContent = data.hasKey
      ? '已保存 ' + data.keyMasked
      : data.needsKey
        ? ''
        : '（不需要）';
    $('mockMode').checked = Boolean(data.mock);
    $('temperature').value = data.temperature ?? 1.25;
    if (data.hasKey && data.mock) {
      $('keyHelp').textContent = '⚠️ 已经保存了 API Key，但「演示模式」是开着的 —— 打开它只会说内置台词，不会调用模型。要真正聊天请把演示模式关掉。';
    }
    $('tempVal').textContent = Number(data.temperature ?? 1.25).toFixed(2).replace(/0$/, '');
    $('apiKey').value = '';
    $('keyHelp').textContent = 'Key 只保存在本机 data/settings.json；不会发给除你选的模型服务以外的任何地方。';
    $('requireAt').checked = data.group.requireAt;
    $('freeChat').checked = data.group.freeChat;
    $('freeChance').value = Math.round((data.group.freeChatChance || 0) * 100);
    $('chanceVal').textContent = Math.round((data.group.freeChatChance || 0) * 100) + '%';
    // 看图 Key 的状态：能看出「配没配、配的是哪一把」，输入框永远不回显明文
    if ($('visionApiKey')) $('visionApiKey').value = '';
    if ($('visionState')) {
      const v = data.vision || {};
      $('visionState').textContent = v.configured ? '已保存 ' + (v.keyMasked || '') : '（未配置）';
    }
    if ($('visionHelp') && data.vision && data.vision.configured && data.vision.model) {
      $('visionHelp').textContent = '当前看图模型：' + data.vision.model + '；留空 = 不改。想换 Key 直接填新的。';
    }
    if ($('visionResult')) {
      $('visionResult').textContent = '';
      $('visionResult').className = 'test-result';
    }
    updateWebhookCodes();
    await refreshStatus();
  } catch {
    toast('读取设置失败，服务还在吗？');
  }
}

function settingsPayload() {
  const payload = {
    provider: $('provider').value,
    baseUrl: $('baseUrl').value.trim(),
    model: $('model').value.trim(),
    mock: $('mockMode').checked,
    temperature: Number($('temperature').value),
    userName: $('userName').value.trim(),
    group: {
      requireAt: $('requireAt').checked,
      freeChat: $('freeChat').checked,
      freeChatChance: Number($('freeChance').value) / 100,
    },
  };
  const key = $('apiKey').value.trim();
  if (key) {
    payload.apiKey = key;
    payload.mock = false; // 填了 Key 就关掉演示模式
  }
  // 看图 Key：留空表示不改（和主 Key 一样，不覆盖已存的）
  const vkey = $('visionApiKey') ? $('visionApiKey').value.trim() : '';
  if (vkey) payload.visionApiKey = vkey;
  return payload;
}

async function saveSettings() {
  const btn = $('saveSettings');
  btn.disabled = true;
  btn.textContent = '正在唤醒…';
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsPayload()),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '保存失败');
    state.userName = $('userName').value.trim();
    localStorage.setItem('whale.userName', state.userName);
    $('settingsModal').hidden = true;
    await refreshStatus();
    if (data.settings && data.settings.vision) {
      state.vision = data.settings.vision;
    }
    if (state.status && !state.status.mock) {
      addMessage({ role: 'system', text: `（鲸鲸浮上水面吸了口气：接下来用 ${data.settings.providerLabel || '新模型'} 说话啦）` });
      toast('已接入 ' + (data.settings.providerLabel || '模型') + '，跟她说句话试试~');
    } else {
      toast('已保存（当前是演示模式）');
    }
  } catch (err) {
    toast('保存失败：' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并唤醒鲸鲸';
  }
}

async function testConnection() {
  const btn = $('btnTest');
  const out = $('testResult');
  btn.disabled = true;
  out.className = 'test-result';
  out.textContent = '正在连接…';
  try {
    const res = await fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsPayload()),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '连接失败');
    const p = data.probe || {};
    if (p.ok) {
      out.className = 'test-result ok';
      out.textContent = `✅ ${p.providerLabel || p.provider} · ${p.model}：连上了（${p.ms}ms）「${p.sample || ''}」`;
      await refreshStatus();
      toast('连接成功！现在可以真的聊天了');
    } else {
      out.className = 'test-result fail';
      out.textContent = '❌ ' + (p.message || '连接失败');
    }
  } catch (err) {
    out.className = 'test-result fail';
    out.textContent = '❌ ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

/** 测试看图：可以先用输入框里没保存的 Key 试，通了再保存 */
async function testVision() {
  const btn = $('btnVisionTest');
  const out = $('visionResult');
  if (!btn || !out) return;
  btn.disabled = true;
  out.className = 'test-result';
  out.textContent = '正在把测试图发给视觉模型…';
  try {
    const typed = $('visionApiKey') ? $('visionApiKey').value.trim() : '';
    const res = await fetch('/api/vision/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(typed ? { apiKey: typed } : {}),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '看图失败');
    out.className = 'test-result ok';
    out.textContent = '✅ 看图可用' + (data.sample ? '：「' + data.sample + '」' : '');
    if (data.vision) {
      $('visionState').textContent = data.vision.configured ? '已保存 ' + (data.vision.keyMasked || '') : '（未配置）';
    }
    if (typed && $('visionState')) {
      out.textContent += '（记得点「保存并唤醒鲸鲸」把 Key 存下来）';
    }
    toast('看图通了');
  } catch (err) {
    out.className = 'test-result fail';
    out.textContent = '❌ ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 记忆 ---------------- */
async function openMemory() {
  $('memoryModal').hidden = false;
  const host = $('memoryList');
  host.innerHTML = '<p class="empty">正在翻小本本…</p>';
  try {
    const res = await fetch(`/api/memory?sessionId=${encodeURIComponent(state.sessionId)}&mode=${state.mode}`);
    const data = await res.json();
    host.textContent = '';
    const rows = data.notes || [];
    if (!rows.length) {
      host.innerHTML = '<p class="empty">小本本还是空的呀。试试说「记住：我怕黑」。</p>';
      return;
    }
    for (const row of rows) {
      const div = document.createElement('div');
      div.className = 'person';
      const strong = document.createElement('strong');
      strong.textContent = row.name || row.uid;
      const ul = document.createElement('ul');
      for (const n of row.notes) {
        const li = document.createElement('li');
        li.textContent = n;
        ul.appendChild(li);
      }
      div.appendChild(strong);
      div.appendChild(ul);
      host.appendChild(div);
    }
  } catch {
    host.innerHTML = '<p class="empty">读取失败，服务还在吗？</p>';
  }
}

async function clearMemory() {
  try {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, mode: state.mode }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '失败');
    $('memoryModal').hidden = true;
    addMessage({ role: 'system', text: '（鲸鲸把这个聊天的记忆丢回海里了）' });
    toast('记忆已清空');
  } catch (err) {
    toast('清空失败：' + err.message);
  }
}

/* ---------------- 输入框 ---------------- */
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(128, inputEl.scrollHeight) + 'px';
}

function bindEvents() {
  sendBtn.addEventListener('click', () => sendMessage());

  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  $('btnMode').addEventListener('click', () => {
    state.mode = state.mode === 'group' ? 'private' : 'group';
    localStorage.setItem('whale.mode', state.mode);
    applyMode();
    addMessage({
      role: 'system',
      text: state.mode === 'group' ? '（切到群聊：深海鱼塘，选一个群友身份说话吧）' : '（切回私聊：只有你和鲸鲸）',
    });
  });

  $('btnSettings').addEventListener('click', openSettings);
  $('btnMemory').addEventListener('click', openMemory);
  $('saveSettings').addEventListener('click', saveSettings);
  $('clearMemory').addEventListener('click', clearMemory);
  $('btnAutoGroup').addEventListener('click', runAutoGroup);
  $('btnTest').addEventListener('click', testConnection);
  const vBtn = $('btnVisionTest');
  if (vBtn) vBtn.addEventListener('click', testVision);

  // 填了 Key 就自动关掉演示模式（否则会一直用内置台词）
  $('apiKey').addEventListener('input', () => {
    if ($('apiKey').value.trim()) $('mockMode').checked = false;
  });

  // 切换模型服务：自动填好该服务的默认地址和模型
  $('provider').addEventListener('change', () => {
    fillProviderFields($('provider').value);
    $('testResult').textContent = '';
    $('testResult').className = 'test-result';
  });

  // 点头像看名片（完整立绘）
  const aboutBtn = $('btnAbout');
  const openAbout = () => { $('aboutModal').hidden = false; };
  aboutBtn.addEventListener('click', openAbout);
  aboutBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAbout();
    }
  });

  $('btnAt').addEventListener('click', () => {
    const prefix = '@鲸鲸 ';
    if (!inputEl.value.includes(prefix)) inputEl.value = prefix + inputEl.value;
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    autoGrow();
  });

  $('temperature').addEventListener('input', (e) => {
    $('tempVal').textContent = Number(e.target.value).toFixed(2).replace(/0$/, '');
  });
  $('freeChance').addEventListener('input', (e) => {
    $('chanceVal').textContent = e.target.value + '%';
  });

  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-close');
      $(id).hidden = true;
    });
  }
  for (const modal of document.querySelectorAll('.modal')) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.hidden = true;
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      for (const modal of document.querySelectorAll('.modal')) modal.hidden = true;
    }
  });

  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const text = $(btn.getAttribute('data-copy')).textContent;
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制：' + text);
      } catch {
        toast('复制失败，手动选中吧：' + text);
      }
    });
  }
}

/* ---------------- 启动 ---------------- */
async function boot() {
  makeBubbles();
  bindEvents();
  applyMode();
  await refreshStatus();
  updateWebhookCodes();

  addMessage({
    role: 'bot',
    text: '在，咋啦？\n有啥想说的就说呗，我今天有点闲',
  });

  // 没配 Key 时她会用内置台词，看着跟真聊一样 —— 第一次进来就说明白
  if (state.status && state.status.mock) {
    addMessage({
      role: 'system',
      text: '（现在是「演示模式」：还没配置 API Key，她回的是内置台词，不是真模型。右上角「设置」填一把 Key 就切成真的了）',
    });
  }

  if (state.mode === 'group') {
    addMessage({ role: 'system', text: '（深海鱼塘：点「让群友来串门」看看她在群里怎么接话）' });
  } else {
    addMessage({ role: 'system', text: '（提示：被叫「鲸鲸」她就会理你；说「记住：…」她会记在小本本上）' });
  }

  setInterval(() => refreshStatus().catch(() => {}), 30000);
}

boot();
