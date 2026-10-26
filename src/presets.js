'use strict';

/**
 * 人设预设：根目录 personas/ 下每个版本一个文件（persona-v1.json、persona-v2.json…）。
 * 只读，升级时新增文件而不是覆盖旧版本，方便对比和回滚。
 */
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/i;

function dirFor(config) {
  const root = (config && config.paths && config.paths.root) || path.resolve(__dirname, '..');
  return path.join(root, 'personas');
}

/** 列出可用的预设文件（按版本号从小到大） */
function list(config) {
  const dir = dirFor(config);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const data = readFile(path.join(dir, name));
    if (!data) continue;
    const id = String(data.id || name.replace(/\.json$/i, ''));
    const version = String(data.version || '');
    out.push({
      id,
      file: name,
      version,
      name: String(data.name || ''),
      description: String(data.description || ''),
      chars: String(data.customPrompt || '').length,
    });
  }
  return out.sort((a, b) => a.version.localeCompare(b.version, 'en', { numeric: true }) || a.id.localeCompare(b.id));
}

function readFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/** 读一个人设预设；找不到返回 null */
function load(config, id) {
  const key = String(id || '').trim();
  if (!key || !ID_RE.test(key)) return null;
  for (const item of list(config)) {
    if (item.id === key || item.file === key || item.file === key + '.json') {
      const data = readFile(path.join(dirFor(config), item.file));
      if (data) return { ...data, id: item.id, file: item.file };
    }
  }
  return null;
}

/** 预设里允许写进人设的字段（不认识的字段忽略，避免带进乱七八糟的东西） */
function toPatch(preset) {
  if (!preset) return null;
  const patch = {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  if (preset.name) patch.name = str(preset.name, 40);
  if (preset.appearance) patch.appearance = str(preset.appearance, 400);
  if (preset.personality) patch.personality = str(preset.personality, 500);
  if (preset.background) patch.background = str(preset.background, 500);
  if (preset.customPrompt) patch.customPrompt = str(preset.customPrompt, 6000);
  if (preset.preset) patch.preset = str(preset.preset, 20);
  if (preset.text) patch.text = str(preset.text, 300);
  if (preset.age) patch.age = Math.max(1, Math.min(120, Number(preset.age) || 23));
  if (preset.privateMaxChars) patch.privateMaxChars = Math.max(40, Math.min(800, Number(preset.privateMaxChars)));
  if (preset.groupMaxChars) patch.groupMaxChars = Math.max(20, Math.min(300, Number(preset.groupMaxChars)));
  if (preset.historyTurns) patch.historyTurns = Math.max(4, Math.min(120, Number(preset.historyTurns)));
  if (preset.groupHistoryTurns) patch.groupHistoryTurns = Math.max(2, Math.min(100, Number(preset.groupHistoryTurns)));
  return Object.keys(patch).length ? patch : null;
}

module.exports = { list, load, toPatch, dirFor };
