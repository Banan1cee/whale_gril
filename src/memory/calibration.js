'use strict';

/**
 * token 估算校准（纯 memory 层模块，只依赖 Node 内置）。
 *
 * 为什么需要：tokens.js 是字符启发式（CJK 0.65 / 其他 0.3），不同服务商 / 模型的
 * chat 模板、分词器差异会让真实 prompt_tokens 系统性偏离。这里按 provider|model
 * 学一个乘数 scale：真实 ≈ 本地估算 × scale。
 *
 * 更新方式：Adam（lr=0.05、β1=0.9、β2=0.999、ε=1e-8），目标 ratio = actual / raw。
 * 约束：
 *   - scale ∈ [0.5, 2.0]，单步最多 ±0.05；
 *   - 前 3 个有效样本只记录，不更新；
 *   - rawEstimate < 400 或 ratio ∉ [0.4, 2.5] 直接丢弃（短 prompt 的固定开销占比太大）；
 *   - 持久化到 data/calibration.json，只存数字，原子写，5 秒防抖；
 *   - 文件损坏 / 权限失败一律静默回落 1.0，绝不因为校准拖垮主流程。
 *
 * 裁剪窗口用 scale 时必须等 n ≥ 10，并量化到 0.05 步长：
 * 否则每轮 scale 微动都会改 recent 窗口，前缀缓存会反复失效。
 */

const fs = require('node:fs');
const path = require('node:path');

const LR = 0.05;
const BETA1 = 0.9;
const BETA2 = 0.999;
const EPS = 1e-8;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.0;
const MAX_STEP = 0.05;
const WARMUP_SAMPLES = 3;
const TRIM_MIN_SAMPLES = 10;
const TRIM_STEP = 0.05;
const MIN_RAW_ESTIMATE = 400;
const MIN_RATIO = 0.4;
const MAX_RATIO = 2.5;
const DEFAULT_DEBOUNCE_MS = 5000;

const ENTRY_KEYS = Object.freeze(['scale', 'm', 'v', 't', 'n', 'updatedAt']);

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function emptyEntry() {
  return { scale: 1, m: 0, v: 0, t: 0, n: 0, updatedAt: 0 };
}

/** 只保留数字字段；任何脏数据都当没写过，回落 1.0 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = emptyEntry();
  for (const key of ENTRY_KEYS) {
    if (!Number.isFinite(Number(raw[key]))) return null;
    entry[key] = Number(raw[key]);
  }
  entry.scale = clamp(entry.scale || 1, MIN_SCALE, MAX_SCALE);
  entry.m = finite(entry.m);
  entry.v = Math.max(0, finite(entry.v));
  entry.t = Math.max(0, Math.floor(entry.t));
  entry.n = Math.max(0, Math.floor(entry.n));
  entry.updatedAt = Math.max(0, entry.updatedAt);
  return entry;
}

function modelKey(provider, model) {
  const p = String(provider == null ? '' : provider).trim().replace(/\|/g, '/') || 'unknown';
  const m = String(model == null ? '' : model).trim().replace(/\|/g, '/') || 'unknown';
  return `${p}|${m}`;
}

function defaultFile() {
  return path.resolve(process.cwd(), 'data', 'calibration.json');
}

class TokenCalibration {
  /**
   * @param {{file?:string|null, now?:Function, debounceMs?:number, provider?:string, model?:string}} [opts]
   *   file=null 表示只放内存（测试 / 模块级默认实例用）。
   */
  constructor({ file = defaultFile(), now = Date.now, debounceMs = DEFAULT_DEBOUNCE_MS, provider = '', model = '' } = {}) {
    this.file = file == null ? null : path.resolve(String(file));
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.debounceMs = Math.max(0, finite(debounceMs, DEFAULT_DEBOUNCE_MS));
    this.provider = String(provider || '');
    this.model = String(model || '');
    this.entries = this._load();
    this._timer = null;
    this._dirty = false;
    this._closed = false;
  }

  setContext(provider, model) {
    this.provider = String(provider || '');
    this.model = String(model || '');
    return this;
  }

  _load() {
    if (!this.file) return {};
    try {
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      const source = parsed && parsed.models && typeof parsed.models === 'object' ? parsed.models : parsed;
      if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
      const out = {};
      for (const [key, value] of Object.entries(source)) {
        const entry = normalizeEntry(value);
        if (entry) out[String(key)] = entry;
      }
      return out;
    } catch {
      // 文件不存在 / JSON 损坏 / 没权限：静默按初始值跑
      return {};
    }
  }

  _entry(key) {
    if (!this.entries[key]) this.entries[key] = emptyEntry();
    return this.entries[key];
  }

  _key(opts = {}) {
    return modelKey(
      opts.provider != null ? opts.provider : this.provider,
      opts.model != null ? opts.model : this.model,
    );
  }

  /** 当前 provider|model 的 scale（原始值，不量化） */
  scaleFor(opts = {}) {
    return this._entry(this._key(opts)).scale;
  }

  /**
   * 给调用方应用当前 scale。
   * @param {number} rawEstimate 本地估算
   * @returns {{key:string, rawEstimate:number, scale:number, calibrated:number, n:number}}
   */
  apply(rawEstimate, opts = {}) {
    const raw = Math.max(0, finite(rawEstimate));
    const key = this._key(opts);
    const entry = this._entry(key);
    return {
      key,
      rawEstimate: raw,
      scale: entry.scale,
      calibrated: Math.max(0, Math.round(raw * entry.scale)),
      n: entry.n,
    };
  }

  /**
   * 喂一条真实样本。前 WARMUP_SAMPLES 条只累计 n，不碰 m/v/t。
   * @param {{rawEstimate:number, actual:number, provider?:string, model?:string}} sample
   */
  observe({ rawEstimate, actual, provider, model } = {}) {
    const raw = Number(rawEstimate);
    const real = Number(actual);
    const key = this._key({ provider, model });
    const entry = this._entry(key);

    if (!Number.isFinite(raw) || raw < MIN_RAW_ESTIMATE) {
      return { accepted: false, reason: 'raw_too_small', key, scale: entry.scale, n: entry.n };
    }
    if (!Number.isFinite(real) || real <= 0) {
      return { accepted: false, reason: 'invalid_actual', key, scale: entry.scale, n: entry.n };
    }
    const ratio = real / raw;
    if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
      return { accepted: false, reason: 'ratio_out_of_range', key, scale: entry.scale, n: entry.n, ratio };
    }

    entry.n += 1;
    entry.updatedAt = Math.max(0, Math.round(finite(this.now())));
    let step = 0;

    if (entry.n > WARMUP_SAMPLES) {
      const gradient = ratio - entry.scale;
      entry.t += 1;
      entry.m = BETA1 * entry.m + (1 - BETA1) * gradient;
      entry.v = BETA2 * entry.v + (1 - BETA2) * gradient * gradient;
      const mHat = entry.m / (1 - Math.pow(BETA1, entry.t));
      const vHat = entry.v / (1 - Math.pow(BETA2, entry.t));
      const rawStep = (LR * mHat) / (Math.sqrt(vHat) + EPS);
      step = clamp(rawStep, -MAX_STEP, MAX_STEP);
      const next = clamp(entry.scale + step, MIN_SCALE, MAX_SCALE);
      // 返回实际发生的步长：触到上下限时可能小于 step
      step = next - entry.scale;
      entry.scale = Number(next.toFixed(6));
    }

    this._scheduleFlush();
    return {
      accepted: true,
      reason: entry.n <= WARMUP_SAMPLES ? 'warmup' : 'updated',
      key,
      ratio,
      step,
      scale: entry.scale,
      n: entry.n,
    };
  }

  /**
   * 裁剪窗口专用 scale：样本不够就 1.0；够了量化到 0.05，避免每轮抖窗口。
   * @returns {number}
   */
  trimScale(opts = {}) {
    const entry = this._entry(this._key(opts));
    if (entry.n < TRIM_MIN_SAMPLES) return 1;
    const quantized = Math.round(entry.scale / TRIM_STEP) * TRIM_STEP;
    return Number(clamp(quantized, MIN_SCALE, MAX_SCALE).toFixed(2));
  }

  _scheduleFlush() {
    if (this._closed) return;
    this._dirty = true;
    if (!this.file) return;
    if (this.debounceMs <= 0) {
      this.flush();
      return;
    }
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.debounceMs);
    // 校准文件晚 5 秒落盘即可，别把进程 / 测试挂住
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** 立即写盘（测试和进程退出前调用）；写失败不影响主流程 */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this.file || !this._dirty) return false;
    const dir = path.dirname(this.file);
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, this.file);
      this._dirty = false;
      return true;
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      return false;
    }
  }

  /** 测试 / 退出用：停掉防抖计时器并落盘 */
  close() {
    this.flush();
    this._closed = true;
  }

  /** 清空内存状态（不删文件，主要用于测试） */
  reset() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.entries = {};
    this._dirty = false;
    return this;
  }
}

function createCalibration(opts = {}) {
  return new TokenCalibration(opts);
}

// 模块级便捷 API：只放内存，避免 require 一下就偷偷读写仓库 data/。
// 需要持久化的调用方用 createCalibration({ file })（Bot 就是这么做的）。
let shared = null;
function sharedEngine() {
  if (!shared) shared = new TokenCalibration({ file: null, debounceMs: 0 });
  return shared;
}

function apply(rawEstimate, opts = {}) {
  return sharedEngine().apply(rawEstimate, opts);
}

function observe(sample = {}) {
  return sharedEngine().observe(sample);
}

function trimScale(opts = {}) {
  return sharedEngine().trimScale(opts);
}

function reset() {
  if (shared) shared.reset();
  return sharedEngine();
}

module.exports = {
  TokenCalibration,
  createCalibration,
  apply,
  observe,
  trimScale,
  reset,
  modelKey,
  defaultFile,
  constants: Object.freeze({
    LR,
    BETA1,
    BETA2,
    EPS,
    MIN_SCALE,
    MAX_SCALE,
    MAX_STEP,
    WARMUP_SAMPLES,
    TRIM_MIN_SAMPLES,
    TRIM_STEP,
    MIN_RAW_ESTIMATE,
    MIN_RATIO,
    MAX_RATIO,
    DEFAULT_DEBOUNCE_MS,
  }),
};
