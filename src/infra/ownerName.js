'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadSettings, saveSettings } = require('./config');

/**
 * 称呼迁移：老版本存在 settings.userName，新版本只认 config.json 的 persona.ownerName。
 * 启动时把旧值搬过去，避免「网页改了、调试台又看到旧值」。
 */
function migrateOwnerName(config) {
  if (!config.persona) config.persona = {};
  let fromSettings = '';
  try {
    fromSettings = String((loadSettings(config) || {}).userName || '').trim();
  } catch { /* 没设置文件就是空的 */ }
  const fromConfig = String(config.persona.ownerName || '').trim();
  if (fromSettings && (!fromConfig || fromConfig === '主人')) {
    config.persona.ownerName = fromSettings;
    try {
      const file = config.paths.configFile;
      let raw = {};
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
      } catch { raw = {}; }
      if (!raw.persona) raw.persona = {};
      raw.persona.ownerName = fromSettings;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      // 只迁移一次：搬完就把老字段清掉，否则以后把称呼改回「主人」重启又会被它盖回去
      try { saveSettings(config, { userName: '' }); } catch { /* 清不掉也没关系 */ }
    } catch { /* 写不了就只改内存，不至于启动失败 */ }
  }
  config.persona.ownerName = String(config.persona.ownerName || '').trim() || '主人';
  return config.persona.ownerName;
}

module.exports = { migrateOwnerName };
