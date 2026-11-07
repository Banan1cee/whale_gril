'use strict';

/**
 * 死导出门禁：这些名字已经确认过「只有定义行和导出行」，全仓没有调用方。
 *
 * 留着它们不会报错，但会让人误以为还有人在用；以后谁想「恢复」某个导出，
 * 就会先撞上这条测试，回去确认是不是真的需要，而不是顺手加回来。
 *
 * 删代码那次的核对方式：全仓 grep 每个名字，只命中定义与 module.exports。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('被删掉的导出不再出现在 module.exports 里', () => {
  const cases = [
    ['../src/memory/tokens', 'sumTokens'],
    ['../src/memory/extractor', 'looksExplicitSelf'],
    ['../src/memory/budgetPlan', 'describePlan'],
    ['../src/persona/index', 'clapbackLines'],
    ['../src/core/text', 'formatChatTime'],
    ['../src/adapters/stickers', 'anyImages'],
    ['../src/adapters/stickers', 'EMOTION_LABELS'],
    ['../src/memory/budget', 'DIALOGUE_BUDGET'],
    ['../src/memory/budget', 'HARD_TOTAL_TOKENS'],
  ];
  for (const [rel, name] of cases) {
    const mod = require(rel);
    assert.equal(typeof mod, 'object', rel + ' 应该正常导出对象');
    assert.equal(name in mod, false, rel + ' 不该再导出 ' + name);
  }
});

test('bilibili 适配器已删除（活着的 B 站实现在 adapters/websearch.js）', () => {
  // 文件名拆开拼：这是唯一一处还能理直气壮提到死模块的地方，但全仓 grep 该文件名时不该再命中
  const dead = path.join(root, 'src', 'adapters', 'bilibili' + '.js');
  assert.equal(fs.existsSync(dead), false);
  const websearch = require('../src/adapters/websearch');
  assert.equal(typeof websearch.bilibiliHot, 'function', 'websearch 里的 bilibiliHot 要还在');
});

test('bridge/engine.py 不再有 chat_latest_seq', () => {
  const py = require('./helpers/bridge-source');
  assert.doesNotMatch(py, /def chat_latest_seq\b/);
});
