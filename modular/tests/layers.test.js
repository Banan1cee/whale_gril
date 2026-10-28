'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { check } = require('../scripts/check-layers');

test('分层依赖检查：没有反向 require', () => {
  const violations = check();
  const detail = violations.map((v) => `${v.file} → ${v.target}（${v.rule}）`).join('\n');
  assert.deepStrictEqual(violations, [], '发现反向依赖：\n' + detail);
});
