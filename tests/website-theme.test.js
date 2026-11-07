'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../website/theme.js'), 'utf8');
function initialTheme(saved, systemLight, blocked = false) {
  const document = { documentElement: { dataset: {} } };
  vm.runInNewContext(script, {
    document,
    localStorage: { getItem() { if (blocked) throw new Error('Storage unavailable'); return saved; } },
    matchMedia: () => ({ matches: systemLight }),
  });
  return document.documentElement.dataset.theme;
}

assert.equal(initialTheme('dark', true), 'dark', '显式选择优先于系统');
assert.equal(initialTheme('light', false), 'light');
assert.equal(initialTheme(null, true), 'light', '首次访问跟随浅色系统');
assert.equal(initialTheme(null, false), 'dark', '首次访问跟随深色系统');
assert.equal(initialTheme('invalid', true), 'light', '损坏的偏好回退到系统');
assert.equal(initialTheme(null, false, true), 'dark', '禁用存储仍能初始化');
console.log('website theme: 6 checks passed');
