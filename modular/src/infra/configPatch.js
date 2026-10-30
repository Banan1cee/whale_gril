'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const configSchema = require('./configSchema');

/* ------------------------------------------------------------------ */
/* 调试台：直接读写 config.json（改完立刻生效，不用重启）              */
/* ------------------------------------------------------------------ */

// 这些路径网页「⚙️ 设置」会写进 data/settings.json，而它的优先级高于 config.json
const SETTINGS_SHADOW = {
  provider: ['provider'],
  'deepseek.provider': ['provider'],
  'deepseek.apiKey': ['apiKey'],
  'deepseek.baseUrl': ['baseUrl'],
  'deepseek.model': ['model'],
  'deepseek.temperature': ['temperature'],
  'deepseek.mock': ['mock'],
  'persona.ownerName': ['userName'],
};

// 密钥类：网页只显示「已设置 / 没配」，留空提交表示「不改」
const SECRET_PATHS = new Set([
  'deepseek.apiKey',
  'vision.apiKey',
  'voice.apiKey',
  'gateway.wechat.inboundToken',
  'gateway.douyin.inboundToken',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function getByPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function setByPath(obj, dotted, value) {
  const parts = String(dotted).split('.').filter(Boolean);
  if (!parts.length) throw new Error('空的字段名');
  for (const p of parts) {
    if (p.startsWith('_') || p === '__proto__' || p === 'constructor' || p === 'prototype') {
      throw new Error('不允许改这个字段：' + dotted);
    }
  }
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/** 按现有配置的类型把网页送来的值转成正确类型（数字/开关/数组/JSON） */
function coerceValue(config, dotted, value) {
  const cur = getByPath(config, dotted);
  if (typeof cur === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value == null ? '' : value).trim());
    if (!Number.isFinite(n)) throw new Error('「' + dotted + '」要填数字');
    return n;
  }
  if (typeof cur === 'boolean') return value === true || value === 'true' || value === 1 || value === '1';
  if (Array.isArray(cur)) {
    if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
    return String(value == null ? '' : value).split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  }
  if (isPlainObject(cur)) {
    if (isPlainObject(value)) return value;
    try {
      return JSON.parse(String(value));
    } catch {
      throw new Error('「' + dotted + '」要填合法的 JSON');
    }
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

/** 给网页看的配置：去掉内部字段，密钥留空但告诉它「配没配」 */
function publicConfig(config) {
  const internal = new Set(['env', 'paths', 'root', 'configExists']);
  const out = JSON.parse(JSON.stringify(config, (k, v) => (internal.has(k) ? undefined : v)));
  const secrets = {};
  for (const p of SECRET_PATHS) {
    const v = getByPath(config, p);
    secrets[p] = Boolean(v && String(v).trim());
    try { setByPath(out, p, ''); } catch { /* 没有这段就算了 */ }
  }
  return { config: out, secrets };
}

/** 把 settings.json 里会「盖住」刚改的字段清掉，否则网页上改了 config.json 却不生效 */
function clearSettingsShadow(runtime, paths) {
  const file = runtime.config.paths.settingsFile;
  let cur;
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    return [];
  }
  const cleared = [];
  for (const p of paths) {
    for (const key of SETTINGS_SHADOW[p] || []) {
      if (Object.prototype.hasOwnProperty.call(cur, key)) {
        delete cur[key];
        cleared.push('settings.' + key);
      }
    }
    if (p.startsWith('group.')) {
      const gk = p.slice('group.'.length);
      if (isPlainObject(cur.group) && Object.prototype.hasOwnProperty.call(cur.group, gk)) {
        delete cur.group[gk];
        cleared.push('settings.group.' + gk);
        if (!Object.keys(cur.group).length) delete cur.group;
      }
    }
  }
  if (cleared.length) {
    try { fs.writeFileSync(file, JSON.stringify(cur, null, 2), 'utf8'); } catch { /* 写不了就算了 */ }
  }
  return cleared;
}

/**
 * 把新读到的配置合并进**原来那个 config 对象**。
 *
 * bot / llm / gateways 都是拿着 config 的引用构造的，只有原地改才不会出现
 *「配置文件改了、某些模块还拿着旧值」的半新半旧状态。
 */
function mergeConfigInPlace(target, src) {
  for (const [key, value] of Object.entries(src || {})) {
    if (key === 'paths' || key === 'env' || key === 'root' || key === 'configExists') continue;
    const cur = target[key];
    const both = isPlainObject(value) && isPlainObject(cur);
    if (both) mergeConfigInPlace(cur, value);
    else target[key] = value;
  }
  return target;
}

/** 把网页提交的 { "persona.name": "新名字" } 写进 config.json 并立刻生效 */
function applyConfigPatch(runtime, patch) {
  if (!isPlainObject(patch)) throw new Error('patch 要是 { 字段名: 新值 } 这样的对象');
  // 消息汇总：先校验再落盘。负数/NaN/极小间隔会导致推送死循环，绝不能写进文件。
  const digestPatch = { ...(isPlainObject(patch.digest) ? patch.digest : {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('digest.')) digestPatch[key.slice('digest.'.length)] = value;
  }
  for (const [key, max] of [['everyMinutes', 1440], ['maxItems', 120]]) {
    if (Object.hasOwn(digestPatch, key)) {
      const value = Number(digestPatch[key]);
      if (!Number.isInteger(value) || value < 1 || value > max) {
        throw Object.assign(new Error(key === 'everyMinutes' ? '消息汇总间隔必须为1～1440分钟的整数' : '消息汇总条数必须为1～120的整数'), { statusCode: 400 });
      }
    }
  }
  if (Object.hasOwn(digestPatch, 'enabled') && typeof digestPatch.enabled !== 'boolean') {
    throw Object.assign(new Error('消息汇总总开关必须是开启或关闭'), { statusCode: 400 });
  }
  if (Object.hasOwn(patch, 'features.digest')) {
    throw Object.assign(new Error('消息汇总总开关请使用 digest.enabled'), { statusCode: 400 });
  }
  const file = runtime.config.paths.configFile;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    raw = {};
  }
  const changed = [];
  const pending = [];
  const errors = [];
  for (const [dotted, value] of Object.entries(patch)) {
    const p = String(dotted || '').trim();
    if (!p) continue;
    // 密钥留空 = 不改（网页上看不到已存的 Key，不能一保存就把它清了）
    if (SECRET_PATHS.has(p) && (value === '' || value === null || value === undefined)) continue;
    const next = coerceValue(runtime.config, p, value);
    const spec = configSchema.FIELDS[p];
    if (spec) {
      const message = configSchema.checkValue(next, spec);
      if (message) {
        errors.push(p + '：' + message);
        continue;
      }
    }
    pending.push([p, next]);
    changed.push(p);
  }
  // 校验先于落盘：填错了就整批拒绝，别出现「改了一半」的状态
  if (errors.length) {
    throw Object.assign(new Error('配置没保存：' + errors.join('；')), { statusCode: 400 });
  }
  if (!changed.length) return { changed, cleared: [] };
  for (const [p, next] of pending) setByPath(raw, p, next);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  const cleared = clearSettingsShadow(runtime, changed);
  mergeConfigInPlace(runtime.config, loadConfig({ root: runtime.config.root, env: runtime.config.env }));
  runtime.stickerService?.reconcile();
  runtime.bot?.digestService?.reconcile();
  if (runtime.llm && typeof runtime.llm.reload === 'function') runtime.llm.reload();
  runtime.logger.info(`调试台保存了设置：${changed.join('、')}${cleared.length ? `（同时清了 ${cleared.join('、')}，让改动真的生效）` : ''}`);
  return { changed, cleared };
}

/** 监听 config.json：手动改完存盘就生效，不用再重启服务。 */
function watchConfigFile(runtime) {
  // 测试/沙箱里 fs.watch 可能不可用，允许关掉（config.watchConfig=false）
  if (runtime.config.watchConfig === false) return;
  const file = runtime.config.paths.configFile;
  let timer = null;
  try {
    const watcher = fs.watch(file, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
          JSON.parse(raw); // 先确认是合法 JSON，写坏了就别覆盖内存里的好配置
          mergeConfigInPlace(runtime.config, loadConfig({ root: runtime.config.root, env: runtime.config.env }));
          runtime.stickerService?.reconcile();
          runtime.bot?.digestService?.reconcile();
          if (runtime.llm && typeof runtime.llm.reload === 'function') runtime.llm.reload();
          runtime.logger.info('config.json 已重新加载（改动已生效，不用重启）');
        } catch (err) {
          runtime.logger.warn(`config.json 改了但没读成功，先按老配置跑：${err && err.message}`);
        }
      }, 250);
    });
    watcher.unref?.();
    // 目录被删/改名时 fs.watch 会 emit('error')，不接住就会把整个进程带崩
    // （沙箱/临时目录里实测：EPERM 直接 throw）。监听失效不该影响服务本身。
    watcher.on?.('error', (err) => {
      runtime.logger.warn(`停止监听 config.json（${err && err.message}）；手动改完请重启服务`);
      try { watcher.close(); } catch { /* ignore */ }
      runtime.configWatcher = null;
    });
    runtime.configWatcher = watcher;
  } catch (err) {
    runtime.logger.warn(`监听 config.json 失败（手动改完记得重启服务）：${err && err.message}`);
  }
}

module.exports = {
  SETTINGS_SHADOW,
  SECRET_PATHS,
  isPlainObject,
  getByPath,
  setByPath,
  coerceValue,
  publicConfig,
  clearSettingsShadow,
  mergeConfigInPlace,
  applyConfigPatch,
  watchConfigFile,
};
