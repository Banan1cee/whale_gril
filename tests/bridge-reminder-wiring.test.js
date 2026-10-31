'use strict';

/**
 * 桥接启动接线回归（Node 侧，与 tests/test_engine_reminder_wiring.py 互补）。
 *
 * 4.0 故障：`main()` 里定义了一个无参的同名 `start_reminder_watch`（闭包版），
 * 遮蔽了模块顶部从 `reminder_watch` 导入的那个；调用处仍按模块级签名传 6 个
 * 关键字参数 → 桥接启动末尾必抛 TypeError，进程 code=1，启动器不会拉起。
 *
 * 这里用文本断言守住调用形态（不导入 engine，它有启动副作用）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'bridge', 'engine.py'), 'utf8');

test('桥接启动调用的是无参闭包版 start_reminder_watch', () => {
  assert.match(src, /def start_reminder_watch\(\):/, 'main() 里的无参闭包版不见了');
  assert.match(src, /^\s{4}start_reminder_watch\(\)\s*$/m, '启动处应无参调用闭包版');
  assert.doesNotMatch(
    src,
    /REMINDER_RUNNER\s*=\s*start_reminder_watch\(/,
    '不要再按模块级签名给闭包版传关键字参数',
  );
});

test('模块级导入仍在，且闭包版会给 REMINDER_RUNNER 赋值', () => {
  assert.match(src, /from reminder_watch import start_reminder_watch/, '模块顶部导入丢了');
  assert.match(src, /REMINDER_RUNNER\s*=\s*ReminderRunner\(/, '闭包版要把实例存进 REMINDER_RUNNER');
});
