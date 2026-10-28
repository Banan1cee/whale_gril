'use strict';

const { normalizeForCompare } = require('./text');

/**
 * 判断回复是不是在复读对方刚说的话（原样重复 / 只加个问号 / 短句高度重合）。
 */
function isEcho(reply, heard) {
  const a = normalizeForCompare(reply);
  const b = normalizeForCompare(heard);
  if (!a || !b) return false;
  if (a === b) return b.length >= 2;
  // 以对方的话开头、只多几个字（「好蠢」→「好蠢啊」）
  if (b.length >= 2 && a.startsWith(b) && a.length - b.length <= 3) return true;
  // 把对方整句包进来，只多了几个字
  if (b.length >= 3 && a.includes(b) && a.length - b.length <= 3) return true;
  if (a.length >= 3 && b.includes(a) && b.length - a.length <= 2) return true;
  // 只把对方的形容词退回去（「你才蠢」）也算偷懒式复读
  if (/^你(才|也|更是)[\u4e00-\u9fff]{1,6}$/.test(a)) return true;
  if (a.length >= 4 && b.length >= 4 && a.length <= 14 && b.length <= 14) {
    let same = 0;
    for (const ch of a) if (b.includes(ch)) same += 1;
    if (same / Math.max(a.length, b.length) >= 0.8) return true;
  }
  return false;
}

module.exports = { isEcho };
