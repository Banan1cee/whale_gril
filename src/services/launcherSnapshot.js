'use strict';

// 启动器未运行内核时只读取配置，不创建聊天运行时、不监听端口、不触发记忆迁移。
const { loadConfig } = require('../infra/config');
const { publicConfig } = require('../infra/configPatch');
const { DeepSeekClient } = require('../llm/client');
const { getSettings } = require('./settings');
const persona = require('../persona/store');
const presets = require('../persona/presets');
const features = require('../infra/features');
const { ReminderService } = require('./reminderService');

function readSnapshot(root, env = process.env) {
  const config = loadConfig({ root, env, readOnly: true });
  Object.defineProperty(config, 'readOnly', { value: true });
  persona.apply(config, persona.load(config));
  const runtime = { config, llm: new DeepSeekClient({ config }) };
  const pub = publicConfig(config);
  const reminders = new ReminderService(config);
  const rules = reminders.rules();
  return {
    '/api/config': { ok: true, config: pub.config, secrets: pub.secrets },
    '/api/settings': getSettings(runtime),
    '/api/persona': { ok: true, persona: persona.summary(config) },
    '/api/persona/presets': { ok: true, presets: presets.list(config) },
    '/api/features': { ok: true, features: features.list(config) },
    '/api/reminders': { ok: true, items: reminders.list(), rules: {
      enabled: rules.enabled, maxPerDay: rules.dailyCap,
      quietAfterMinutes: rules.quietAfterMinutes, sentToday: rules.sentToday,
    } },
  };
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(readSnapshot(process.cwd()))); }
  catch { process.stderr.write('无法读取本地配置，请检查配置文件格式与目录权限。'); process.exitCode = 1; }
}

module.exports = { readSnapshot };
