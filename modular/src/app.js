'use strict';

/**
 * 运行时组装（唯一的依赖注入点）：
 *   config / logger / store / llm / bot / gateways
 * 所有模块都从这里拿到依赖，不再各自 require 单例。
 */
const path = require('node:path');
const { ensureConfigFile, loadConfig } = require('./infra/config');
const { createLogger } = require('./infra/logger');
const { migrateOwnerName } = require('./infra/ownerName');
const { watchConfigFile } = require('./infra/configPatch');
const features = require('./infra/features');
const configSchema = require('./infra/configSchema');
const { Store } = require('./memory/store');
const memoryBackup = require('./memory/backup');
const mediaCache = require('./adapters/mediaCache');
const { DeepSeekClient } = require('./llm/client');
const { Bot } = require('./pipeline/chat');
const { createGateways } = require('./adapters/gateway');
const personaStore = require('./persona/store');
const { StickerService } = require('./services/stickerService');

const VERSION = require('../package.json').version;

function createRuntime({ root = path.resolve(__dirname, '..'), env = process.env, loggerLevel } = {}) {
  ensureConfigFile(root);
  const config = loadConfig({ root, env });
  // 称呼只认一个真源：config.json 的 persona.ownerName。
  // 老版本把它存在 data/settings.json 的 userName 里，这里做一次迁移，之后网页设置和调试台改的是同一个值。
  migrateOwnerName(config);
  // 加载主人在微信里调过的语态 / 能力（data/persona.json）
  personaStore.apply(config, personaStore.load(config));
  // 测试/自检可以传 WHALE_LOG_FILE='' 关掉文件日志：Windows 上'日志流没关'会把 data 目录占住，删不掉
  const logFileFromEnv = Object.prototype.hasOwnProperty.call(env || {}, 'WHALE_LOG_FILE') ? String(env.WHALE_LOG_FILE) : null;
  const logFile = logFileFromEnv === null ? config.paths.logFile : (logFileFromEnv || null);
  const logger = createLogger({ level: loggerLevel || config.log.level, file: logFile });
  // 配置体检：非法值以前会被各处的 `Number(x) || 默认` 静默吃掉，
  // 用户在调试台填错了也看不出来。这里启动时报一次，不阻断运行。
  try {
    const configErrors = configSchema.validate(config);
    if (configErrors.length) {
      logger.warn(
        'config.json 有 ' + configErrors.length + ' 项不合法（会按原值继续跑，建议修掉）：' +
          configSchema.formatErrors(configErrors)
      );
    }
  } catch { /* 校验失败不影响启动 */ }
  const store = new Store({ file: config.paths.storeFile, limits: config.memory, logger });
  // 启动时先「忘」一遍：太久没被想起、又不重要的记忆沉到归档，别一直占着检索位
  try {
    const swept = store.sweep();
    if (swept.archived || swept.evicted) {
      logger.info(`记忆清理：归档 ${swept.archived} 条、淘汰 ${swept.evicted} 条（归档共 ${store.archiveCount()} 条）`);
    }
  } catch (err) {
    logger.warn('记忆清理失败（不影响使用）：' + ((err && err.message) || err));
  }
  // 每次启动留一份记忆快照：换目录/重装/误点重置都能捞回来
  try {
    const snap = features.isOn(config, 'memorySnapshot') ? memoryBackup.writeSnapshot(root, 'startup') : null;
    if (snap) logger.info('记忆快照：' + snap);
  } catch (err) {
    logger.warn('记忆快照失败（不影响使用）：' + err.message);
  }
  // 媒体缓存（图片/表情包/语音 wav）永不清理会越堆越大，启动时清一次
  try {
    if (features.isOn(config, 'mediaCleanup')) {
      const mediaDir = path.join(root, 'data', 'media-cache');
      const mc = mediaCache.cleanup(mediaDir, {
        maxAgeDays: Number((config.storage || {}).mediaKeepDays) || 7,
        maxTotalMB: Number((config.storage || {}).mediaMaxMB) || 500,
      });
      if (mc.removed) logger.info(`媒体缓存清理：删 ${mc.removed} 个文件，释放 ${mc.freedMB} MB`);
    }
  } catch (err) {
    logger.warn('媒体缓存清理失败（不影响使用）：' + err.message);
  }

  const runtime = { config, logger, store, startedAt: Date.now(), version: VERSION };

  // 长时间挂着也要有断点：每 30 分钟留一份（启动那份可能已经是几十小时前了）
  try {
    const timer = setInterval(() => {
      try {
        if (!features.isOn(runtime.config, 'memorySnapshot')) return;
        const file = memoryBackup.writeSnapshot(root, 'cron');
        if (file) logger.info('记忆快照（定时）：' + file);
      } catch (err) {
        logger.warn('定时记忆快照失败：' + err.message);
      }
    }, 30 * 60 * 1000);
    if (timer.unref) timer.unref();
  } catch { /* 定时器起不来不影响主流程 */ }

  runtime.llm = new DeepSeekClient({ config, logger });
  runtime.bot = new Bot({ config, store, llm: runtime.llm, logger });
  // 表情包任务队列：内存态，重启不重放（避免把上一条没发出去的表情再补发一次）
  runtime.stickerService = new StickerService(config);
  runtime.bot.stickerService = runtime.stickerService;
  runtime.gateways = createGateways({ config, bot: runtime.bot, logger });
  watchConfigFile(runtime);
  return runtime;
}

module.exports = { VERSION, createRuntime };
