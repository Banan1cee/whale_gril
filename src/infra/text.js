'use strict';

/**
 * 文本清洗：合并 services/contacts.js 与 services/reminderService.js 里逐字节相同的两份实现。
 *
 * 语义（不要顺手统一成别的版本）：
 *   - null / undefined → 空串
 *   - 只把 C0 控制字符（\u0000-\u001f）换成空格；不碰 \u007f
 *   - 不压缩连续空白（只 trim）
 *   - 超长直接 slice，不加省略号
 *
 * core/events.js 与 infra/errors.js 里同名函数行为不同（前者压 \s{2,} 且多剥 \u007f，
 * 后者压 \s+ 且超长加 …），已分别更名为 clipControl / clipWithEllipsis，不合并。
 */
function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

module.exports = { clean };
