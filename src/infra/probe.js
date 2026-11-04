'use strict';

/**
 * 计时探针（2026-11-04 临时工具）—— 只测量，不改变任何行为。
 *
 * 约定：
 *   - 所有输出行都以 `[probe]` 开头，方便事后 grep / 删除；
 *   - 走 logger 的 debug 级（默认只落盘 data/whale.log，不刷控制台）；
 *     超过阈值的慢路径升到 warn，用户/我们都能在 kernel.log 里一眼看到；
 *   - 没有注入 logger 就完全静默：`stickerLibraryLocal.js` 会把 stdout 当 JSON 解析，
 *     探针绝不能往 stdout 写东西；
 *   - 事件循环探针默认关，`WHALE_PROBE_LOOP=1` 才启动（文档里就是这么要求的）。
 *
 * 移除方式：删掉调用点即可，本文件没有副作用。
 */
const { performance } = require('node:perf_hooks');

/** 单调时钟（perf_hooks），单位 ms */
function now() {
  return performance.now();
}

/** 保留 1 位小数：探针数字不需要更高精度，日志也更好读 */
function ms(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

/** 写一行探针日志；logger 缺失或没有该级别就静默跳过 */
function emit(logger, level, text) {
  try {
    if (!logger || typeof logger[level] !== 'function') return;
    logger[level]('[probe] ' + text);
  } catch { /* 探针自己不许把主流程搞挂 */ }
}

/**
 * 事件循环延迟采样：`WHALE_PROBE_LOOP=1` 时启动，超过阈值（默认 100ms）记一条 debug。
 * 同步扫描/迁移会把主线程堵住，这条数字就是「卡死」的直接证据。
 *
 * 两个度量一起用：
 *   - perf_hooks.monitorEventLoopDelay 是文档要求的，但实测（Node 24，本机）**抓不到长阻塞**：
 *     libuv 会跳过错过的定时器周期，3 秒同步阻塞读到的峰值只有 32ms；
 *   - 自排队 setTimeout 的「迟到量」能如实报出 2949.6ms / 3s 阻塞。
 * 所以两条都记：histogram 用来看常态抖动，lag 用来看真正的卡死。
 */
function startEventLoopProbe(logger, { thresholdMs = 100, resolution = 20, intervalMs = 5000, lagIntervalMs = 50 } = {}) {
  if (String(process.env.WHALE_PROBE_LOOP || '') !== '1') return null;
  try {
    const { monitorEventLoopDelay } = require('node:perf_hooks');
    const histogram = monitorEventLoopDelay({ resolution });
    histogram.enable();
    let histPeak = 0;
    let lagPeak = 0;

    const timer = setInterval(() => {
      const max = histogram.max / 1e6;
      histogram.reset();
      if (!Number.isFinite(max) || max <= 0) return;
      if (max > histPeak) histPeak = max;
      if (max >= thresholdMs) emit(logger, 'debug', `histogram 最长延迟 ${ms(max)}ms（阈值 ${thresholdMs}ms）`);
    }, intervalMs);
    if (timer.unref) timer.unref();

    // 真正的阻塞计量：每 50ms 自排一次，醒来时「晚到多久」就是这一轮的事件循环延迟
    let expected = now() + lagIntervalMs;
    const lagTimer = setInterval(() => {
      const t = now();
      const lag = t - expected;
      expected = t + lagIntervalMs;
      if (lag <= 0) return;
      if (lag > lagPeak) lagPeak = lag;
      if (lag >= thresholdMs) emit(logger, 'debug', `事件循环阻塞 ${ms(lag)}ms（阈值 ${thresholdMs}ms）`);
    }, lagIntervalMs);
    if (lagTimer.unref) lagTimer.unref();

    return {
      histogram,
      peak: () => Math.max(histPeak, lagPeak),
      stop() {
        clearInterval(timer);
        clearInterval(lagTimer);
        try { histogram.disable(); } catch { /* ignore */ }
        emit(logger, 'debug', `事件循环峰值 histogram=${ms(histPeak)}ms lag=${ms(lagPeak)}ms`);
      },
    };
  } catch {
    return null;
  }
}

module.exports = { now, ms, emit, startEventLoopProbe };
