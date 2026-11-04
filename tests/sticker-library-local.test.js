'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { run } = require('../src/services/stickerLibraryLocal');

test('离线打开指定分类，拖进文件夹后仅在对应分类显示', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-local-stickers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ sticker: { dir: '图库' } }));
  const before = run(root, 'inventory');
  assert.equal(before.enabled, false);
  assert.deepEqual(before.emotions.map(category => category.key), ['cute', 'angry', 'happy']);
  assert.equal(fs.existsSync(before.dir), false, '浏览不创建目录');
  const { dir } = run(root, 'open', 'angry');
  assert.equal(dir, path.join(root, '图库', '炸毛'));
  fs.writeFileSync(path.join(dir, '表情.gif'), Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  const after = run(root, 'inventory');
  assert.deepEqual(after.emotions.map(category => category.count), [0, 1, 0]);
  assert.equal(after.emotions[1].items[0].id, '炸毛/表情.gif');
  assert.throws(() => run(root, 'open', 'x:../escape'), /有效分类/);
  assert.equal(fs.existsSync(path.join(root, 'data', 'memory')), false);
});
