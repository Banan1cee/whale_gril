'use strict';

/**
 * 收消息时的文本归一：合并 memory/extractor.js:18 与 memory/relations.js:257
 * （两份逐字节相同）。
 *
 * 语义（别顺手加东西）：
 *   - null / undefined → 空串
 *   - 去掉「昵称:」这种说话人前缀（4 位以上英文/数字/下划线/横线）
 *   - 去掉行首的 @某人
 *   - 连续空白压成一个、首尾 trim
 *
 * persona/index.js 里那个同名函数吃 config、处理别名与图片描述，是另一个东西，
 * 已更名 cleanIncomingForPersona，不合并。
 */
function cleanIncoming(text) {
  return String(text || '')
    .replace(/^[A-Za-z0-9_-]{4,}:\s*/, '')
    .replace(/^@\S+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { cleanIncoming };
