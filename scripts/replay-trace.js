#!/usr/bin/env node
'use strict';

/**
 * 回放判定链：改完触发规则以后，用 data/trace 里的历史输入重跑一遍，
 * 看「当时的结论」和「现在的结论」差在哪 —— 不用等线上再踩一次。
 *
 * 用法：
 *   node scripts/replay-trace.js                      最近 3 天的 trace，最后 20 条
 *   node scripts/replay-trace.js --limit 200          多看几条
 *   node scripts/replay-trace.js --fp ab12cd34        只回放某一条（日志里那个 fp）
 *   node scripts/replay-trace.js --file data/trace/trace-20261102.jsonl
 *   node scripts/replay-trace.js --json               机器可读输出
 *
 * 说明：
 *   1. 触发判定（trigger.js）只覆盖「群里要不要接」这一段。trace 里 reason 是
 *      duplicate / muted / burst_limit / global_minute_cap / system_notice 的，
 *      是 decide() 后段的闸门，这里只标注、不重跑。
 *   2. 依赖正文的规则（骂人、叫名字）需要 data/trace/raw/<fp>.json。
 *      没有原文（没开 traceRaw / 已被 24 小时清理）时用空正文，输出会标「无原文」。
 *   3. 用的是**当前** config.json 和当前代码：这正是「改完规则先预演」想要的效果。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const trigger = require(path.join(root, 'src', 'core', 'trigger'));
const { loadConfig } = require(path.join(root, 'src', 'infra', 'config'));

const TRIGGER_REASONS = new Set([
  'private', 'addressed', 'question_mark', 'directed', 'silent', 'master',
  'engaged', 'engaged_group', 'engaged_side_chatter', 'followup',
  'minute_cap', 'free_chat', 'not_addressed', 'no_text', 'insulted',
]);

function parseArgs(argv) {
  const out = { limit: 20, fp: '', file: '', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Math.max(1, Number(argv[++i]) || 20);
    else if (a === '--fp') out.fp = String(argv[++i] || '').trim();
    else if (a === '--file') out.file = String(argv[++i] || '').trim();
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function traceFiles(opts) {
  if (opts.file) return [path.resolve(root, opts.file)];
  const dir = path.join(root, 'data', 'trace');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => /^trace-\d{8}\.jsonl$/.test(n))
    .sort()
    .map((n) => path.join(dir, n));
}

function loadEntries(opts) {
  const entries = [];
  for (const file of traceFiles(opts)) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const e = JSON.parse(s);
        e.__file = path.basename(file);
        entries.push(e);
      } catch { /* 坏行跳过 */ }
    }
  }
  const filtered = opts.fp ? entries.filter((e) => e.fp === opts.fp) : entries;
  return filtered.slice(-opts.limit);
}

function rawText(fp) {
  try {
    const p = path.join(root, 'data', 'trace', 'raw', fp + '.json');
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return typeof raw.text === 'string' ? raw.text : null;
  } catch { return null; }
}

/** 用「现在」重建录下来的相对状态（剩下的秒数 → 新的绝对时间） */
function buildState(entry, nowMs) {
  const st = entry.state || {};
  const state = {};
  if (Number(st.silent) > 0) state.silentUntil = nowMs + Number(st.silent) * 1000;
  if (Number(st.engaged) > 0) state.engagedUntil = nowMs + Number(st.engaged) * 1000;
  if (Number(st.muted) > 0) state.mutedUntil = nowMs + Number(st.muted) * 1000;
  return state;
}

function replay(entry, bot) {
  const nowMs = Date.now();
  const isGroup = String(entry.chat || '').startsWith('g:');
  const text = rawText(entry.fp);
  const state = buildState(entry, nowMs);
  const msg = {
    platform: 'wechat',
    chatId: entry.chat,
    chatType: isGroup ? 'group' : 'private',
    senderId: 'replay',
    senderName: '',
    text: text == null ? '' : text,
    atMe: Boolean(entry.atMe),
    replyToBot: Boolean(entry.quote),
    mentionedNames: [],
    isMaster: Boolean(entry.master),
  };
  const args = {
    msg,
    atMe: Boolean(entry.atMe),
    clean: { text: msg.text },
    isGroup,
    state,
    nowMs,
    isMaster: Boolean(entry.master),
    key: entry.chat,
  };
  let now;
  try {
    now = trigger.computeTrigger(bot, args);
  } catch (err) {
    now = { wake: false, reason: 'replay_error: ' + ((err && err.message) || err) };
  }
  // 没原文时，no_text 和 not_addressed 是同一件事（都是「没叫她」），别报成差异
  const norm = (r) => (text == null && (r === 'no_text' || r === 'not_addressed')) ? 'not_addressed' : r;
  return {
    fp: entry.fp,
    at: entry.at,
    chat: entry.chat,
    recorded: { action: entry.action, reason: entry.reason },
    now: { action: now.wake ? 'reply' : 'ignore', reason: now.reason },
    changed: (now.wake ? 'reply' : 'ignore') !== entry.action || norm(now.reason) !== norm(entry.reason),
    hasRaw: text != null,
    covered: TRIGGER_REASONS.has(entry.reason),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法: node scripts/replay-trace.js [--limit N] [--fp <fp>] [--file <jsonl>] [--json]');
    return;
  }
  const entries = loadEntries(opts);
  if (!entries.length) {
    console.log('没有可回放的 trace。检查 data/trace/ 是否存在，或先用 --file 指定文件。');
    return;
  }
  const config = loadConfig({ root });
  const bot = { config, rng: Math.random, store: { messages: () => [] } };
  const results = entries.map((e) => replay(e, bot));

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  let changed = 0;
  let uncovered = 0;
  let noRaw = 0;
  for (const r of results) {
    if (r.changed) changed++;
    if (!r.covered) uncovered++;
    if (!r.hasRaw) noRaw++;
    const flag = r.changed ? '差异' : '一致';
    const note = !r.covered ? '（该原因在 decide 后段，未回放）' : (r.hasRaw ? '' : '（无原文，只验证状态类规则）');
    console.log(`[${flag}] ${r.at} ${r.fp} ${r.chat}${note}`);
    console.log(`        当时: ${r.recorded.action}/${r.recorded.reason}   现在: ${r.now.action}/${r.now.reason}`);
  }
  console.log('');
  console.log(`共 ${results.length} 条：${changed} 条结论变了，${results.length - changed} 条一致。`);
  if (uncovered) console.log(`${uncovered} 条属于「限流/去重/静音」这类后段闸门，trigger 回放不覆盖（看 trace 里的 reason 就够）。`);
  if (noRaw) console.log(`${noRaw} 条没有原文副本：只验证了状态类规则；要完整回放请保持 log.traceRaw=true，并在 24 小时内跑。`);
}

main();
