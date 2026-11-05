'use strict';

/**
 * 公共小模块的行为固定：这些函数是从多处同名实现合并出来的，
 * 合并前后每个调用点都必须保持原行为。这里钉住最容易被「顺手改一下」弄坏的边界。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readJson } = require('../src/infra/jsonFile');
const { getByPath } = require('../src/infra/objpath');
const { clean } = require('../src/infra/text');
const { cleanIncoming } = require('../src/memory/text');

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-shared-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('readJson：读得到、坏 JSON / 不存在返回 fallback', () => {
  const good = tmpFile('ok.json', '{"a":1}');
  assert.deepEqual(readJson(good), { a: 1 });
  // 两个旧调用约定都要成立：不传 fallback → null；传了 → 原样返回
  assert.equal(readJson(path.join(path.dirname(good), 'missing.json')), null);
  assert.deepEqual(readJson(path.join(path.dirname(good), 'missing.json'), {}), {});
  const broken = tmpFile('broken.json', '{ nope');
  assert.equal(readJson(broken), null);
  assert.deepEqual(readJson(broken, []), []);
});

test('readJson：容忍 UTF-8 BOM（旧四份实现都剥了它）', () => {
  const file = tmpFile('bom.json', '\uFEFF{"b":2}');
  assert.deepEqual(readJson(file), { b: 2 });
});

test('getByPath：深层取值、null 中间值、0/空串中间值都返回 undefined 而不是抛', () => {
  const obj = { a: { b: { c: 42 } }, zero: 0, empty: '', nul: null };
  assert.equal(getByPath(obj, 'a.b.c'), 42);
  assert.equal(getByPath(obj, 'a.b'), obj.a.b);
  assert.equal(getByPath(obj, 'a.missing.c'), undefined);
  assert.equal(getByPath(obj, 'nul.x'), undefined);
  // 合并前三份里 features 版用 !cur 提前返回；统一成显式 null 判断后，
  // 0 / '' 会走到属性访问，结果仍是 undefined（属性访问在原始值上不抛）
  assert.equal(getByPath(obj, 'zero.x'), undefined);
  assert.equal(getByPath(obj, 'empty.x'), undefined);
  assert.equal(getByPath(obj, undefined), undefined);
});

test('clean：只换 C0 控制字符、不压连续空白、超长不加省略号（contacts/reminderService 那版）', () => {
  assert.equal(clean(null, 10), '');
  assert.equal(clean(undefined, 10), '');
  assert.equal(clean('a\u0001b', 10), 'a b');
  // 合并前只剥 \u0000-\u001f，\u007f 要保留（events 版才剥它）
  assert.equal(clean('a\u007fb', 10), 'a\u007fb');
  // 不压内部连续空白，只 trim
  assert.equal(clean('  a  b  ', 10), 'a  b');
  // 截断无省略号
  assert.equal(clean('abcdef', 3), 'abc');
});

test('clipControl / clipWithEllipsis：更名后模块可用，旧名 clean 不再定义', () => {
  const events = require('../src/core/events');
  const errors = require('../src/infra/errors');
  assert.equal(typeof events.describe, 'function');
  const out = errors.describeError(Object.assign(new Error('x'.repeat(300)), { detail: 'y'.repeat(300) }));
  assert.match(out, /detail=/, 'describeError 仍输出结构字段');
  // 两个文件里的旧名 clean 已更名；只检查源码里不再有 function clean(（同文件其它 cleanXxx 不算）
  for (const [rel, fn] of [['../src/core/events.js', 'clipControl'], ['../src/infra/errors.js', 'clipWithEllipsis']]) {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', rel.replace('../src/', '')), 'utf8');
    assert.match(src, new RegExp('function ' + fn + '\\('));
    assert.doesNotMatch(src, /function clean\(/);
  }
});

test('cleanIncoming：去「昵称:」前缀、去行首 @、压空白；persona 版已更名', () => {
  assert.equal(cleanIncoming('wxid_abc123: 你好'), '你好');
  assert.equal(cleanIncoming('@鲸鲸 在吗'), '在吗');
  assert.equal(cleanIncoming('  a   b  '), 'a b');
  assert.equal(cleanIncoming(null), '');
  const persona = require('../src/persona/index');
  assert.equal(typeof persona.cleanIncomingForPersona, 'function');
  assert.equal('cleanIncoming' in persona, false, 'persona 版已更名，不该再导出旧名');
});
