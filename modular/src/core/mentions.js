'use strict';

const persona = require('../persona');

/** 从文本里提取 @ 到的人名，排除鲸鲸自己的别名 */
function extractMentionNames(text, config) {
  const aliases = new Set(persona.aliasList(config).map((x) => String(x).toLowerCase()));
  const names = [];
  const re = /@\s*([^\s@，,：:！!~～…?？。—]+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const name = m[1].trim();
    if (name && !aliases.has(name.toLowerCase()) && !names.some((x) => x.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names.slice(0, 4);
}

module.exports = { extractMentionNames };
