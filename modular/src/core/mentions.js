'use strict';

/**
 * 从文本里提取 @ 到的人名，排除鲸鲸自己的别名。
 *
 * 这里**不 require persona**：core 层要保持「只依赖 core」。
 * 别名由调用方传进来（通常是 `persona.aliasList(config)`）。
 *
 * @param {string} text
 * @param {string[]|Set<string>} aliases  鲸鲸自己的名字/外号
 * @returns {string[]} 最多 4 个
 */
function extractMentionNames(text, aliases) {
  const list = aliases instanceof Set ? [...aliases] : (Array.isArray(aliases) ? aliases : []);
  const self = new Set(list.map((x) => String(x).toLowerCase()));
  const names = [];
  const re = /@\s*([^\s@，,：:！!~～…?？。—]+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const name = m[1].trim();
    if (name && !self.has(name.toLowerCase()) && !names.some((x) => x.toLowerCase() === name.toLowerCase())) {
      names.push(name);
    }
  }
  return names.slice(0, 4);
}

module.exports = { extractMentionNames };
