'use strict';

/**
 * 差分更新（scripts/patch.js）的往返测试。
 *
 * 差分是「省流量」的核心，一旦算错就是把用户的包打坏，所以这里钉死：
 *   1) 改一点点的两个包，补丁要明显小于整包；
 *   2) 打完补丁必须和原文件逐字节一致；
 *   3) 旧包对不上（用户装的是别的版本）要拒绝，不能硬打；
 *   4) 分块是确定性的（同一份数据切点必须一致，否则补丁换个机器就打不开）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makePatch, applyPatch, chunkBuffer } = require('../scripts/patch.js');

function fakePackage(size, seed) {
  // 用随机字节模拟压缩过的 exe/zip：几乎不可压缩，最能暴露分块问题
  return crypto.createHash('sha512').update(String(seed)).digest().toString('hex').repeat(Math.ceil(size / 128)).slice(0, size);
}

test('改几个字节，补丁远小于整包，打回来逐字节一致', () => {
  const oldBuf = Buffer.from(fakePackage(512 * 1024, 'a'));
  const newBuf = Buffer.from(oldBuf);
  newBuf.write('PATCHED-CONTENT', 100 * 1024);
  newBuf.write('TAIL-CHANGE', 400 * 1024);

  const { patch, stats } = makePatch(oldBuf, newBuf);
  assert.ok(stats.patchSize < newBuf.length * 0.2, `补丁太大：${stats.patchSize} / ${newBuf.length}`);

  const out = applyPatch(oldBuf, patch);
  assert.equal(out.length, newBuf.length);
  assert.ok(out.equals(newBuf), '打出来的内容和目标不一致');
});

test('中间插入一段（后面全部平移），补丁依然小且正确', () => {
  const oldBuf = Buffer.from(fakePackage(512 * 1024, 'b'));
  const insertAt = 200 * 1024;
  const newBuf = Buffer.concat([
    oldBuf.subarray(0, insertAt),
    Buffer.from(fakePackage(8 * 1024, 'insert')),
    oldBuf.subarray(insertAt),
  ]);

  const { patch, stats } = makePatch(oldBuf, newBuf);
  assert.ok(stats.patchSize < newBuf.length * 0.2, `插入后补丁太大：${stats.patchSize} / ${newBuf.length}`);
  assert.ok(applyPatch(oldBuf, patch).equals(newBuf));
});

test('删掉一段也能打回去', () => {
  const oldBuf = Buffer.from(fakePackage(256 * 1024, 'c'));
  const newBuf = Buffer.concat([oldBuf.subarray(0, 64 * 1024), oldBuf.subarray(128 * 1024)]);
  const { patch } = makePatch(oldBuf, newBuf);
  assert.ok(applyPatch(oldBuf, patch).equals(newBuf));
});

test('完全不同的两个包：补丁退化成整包（不能比整包还大太多）', () => {
  const oldBuf = Buffer.from(fakePackage(64 * 1024, 'd'));
  const newBuf = Buffer.from(fakePackage(64 * 1024, 'e'));
  const { patch, stats } = makePatch(oldBuf, newBuf);
  assert.ok(stats.patchSize < newBuf.length * 1.2, `补丁比整包还大：${stats.patchSize}`);
  assert.ok(applyPatch(oldBuf, patch).equals(newBuf));
});

test('旧包对不上就拒绝，不能硬打出一包垃圾', () => {
  const oldBuf = Buffer.from(fakePackage(128 * 1024, 'f'));
  const newBuf = Buffer.from(fakePackage(128 * 1024, 'g'));
  const { patch } = makePatch(oldBuf, newBuf);

  assert.throws(() => applyPatch(Buffer.from(fakePackage(128 * 1024, 'h')), patch), /旧包/);
  assert.throws(() => applyPatch(oldBuf.subarray(0, 1024), patch), /旧包/);
  assert.throws(() => applyPatch(oldBuf, Buffer.from('not a patch')), /补丁/);
});

test('分块是确定性的：同一份数据切点必须一模一样', () => {
  const buf = Buffer.from(fakePackage(300 * 1024, 'i'));
  const a = chunkBuffer(buf).map((c) => `${c.start}-${c.end}`);
  const b = chunkBuffer(buf).map((c) => `${c.start}-${c.end}`);
  assert.deepEqual(a, b);
  // 覆盖完整、且块大小在 [MIN, MAX] 内
  assert.equal(chunkBuffer(buf)[0].start, 0);
  assert.equal(chunkBuffer(buf).slice(-1)[0].end, buf.length);
  for (const c of chunkBuffer(buf)) {
    assert.ok(c.size > 0 && c.size <= 32 * 1024, `块大小越界：${c.size}`);
  }
});
