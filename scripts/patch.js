'use strict';

/**
 * 差分更新：算出「旧包 → 新包」的补丁，客户端只下补丁，本地打回去。
 *
 * 为什么不用 bsdiff：仓库零 npm 依赖，bsdiff 要么带二进制要么重写后缀数组。
 * 这里用内容定义分块（CDC，gear hash）：
 *   - 滚动哈希决定切点，插入/删除只会让切点局部错位，后面很快重新对齐；
 *   - 新包每个块先去旧包里找同哈希同内容的块，找到就记一条 COPY，找不到才记字面量；
 *   - 字面量整体 deflate 一次（node 自带 zlib）。
 * 对 exe/zip 这种「前面改一点、后面全平移」的文件，比固定分块强得多。
 *
 * 用法：
 *   node scripts/patch.js make <旧文件> <新文件> <输出.patch>
 *   node scripts/patch.js apply <旧文件> <补丁> <输出文件>
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAGIC = Buffer.from('WGPATCH1', 'utf8');
const MIN_CHUNK = 2 * 1024;
const AVG_CHUNK = 8 * 1024;
const MAX_CHUNK = 32 * 1024;
const MASK = AVG_CHUNK - 1;

// 固定种子的 gear 表：生成端和客户端必须完全一致，所以不能随机
const GEAR = (() => {
  const table = new Uint32Array(256);
  let seed = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    table[i] = seed;
  }
  return table;
})();

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 把 buffer 按 CDC 切块，回调 (start, end, hash) */
function chunkBuffer(buf) {
  const chunks = [];
  let start = 0;
  let h = 0;
  for (let i = 0; i < buf.length; i++) {
    h = ((h << 1) + GEAR[buf[i]]) >>> 0;
    const size = i - start + 1;
    if (size >= MIN_CHUNK && ((h & MASK) === 0 || size >= MAX_CHUNK)) {
      chunks.push({ start, end: i + 1, hash: h, size });
      start = i + 1;
      h = 0;
    }
  }
  if (start < buf.length) chunks.push({ start, end: buf.length, hash: h, size: buf.length - start });
  return chunks;
}

function makePatch(oldBuf, newBuf) {
  const index = new Map();
  for (const c of chunkBuffer(oldBuf)) {
    const list = index.get(c.hash);
    if (list) { if (list.length < 8) list.push(c); } else index.set(c.hash, [c]);
  }

  const ops = [];
  const literals = [];
  let litBytes = 0;
  let copied = 0;

  for (const c of chunkBuffer(newBuf)) {
    const cands = index.get(c.hash) || [];
    let hit = null;
    for (const o of cands) {
      if (o.size !== c.size) continue;
      if (oldBuf.compare(newBuf, c.start, c.end, o.start, o.end) === 0) { hit = o; break; }
    }
    if (hit) {
      ops.push(['c', hit.start, c.size]);
      copied += c.size;
    } else {
      ops.push(['l', litBytes, c.size]);
      literals.push(newBuf.subarray(c.start, c.end));
      litBytes += c.size;
    }
  }

  const litRaw = literals.length ? Buffer.concat(literals) : Buffer.alloc(0);
  const litComp = zlib.deflateSync(litRaw, { level: 9 });
  const header = {
    format: 1,
    newSize: newBuf.length,
    oldSize: oldBuf.length,
    oldSha256: sha256(oldBuf),
    newSha256: sha256(newBuf),
    litSize: litRaw.length,
    ops,
  };
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerBuf.length, 0);

  return {
    patch: Buffer.concat([MAGIC, lenBuf, headerBuf, litComp]),
    stats: {
      oldSize: oldBuf.length,
      newSize: newBuf.length,
      patchSize: MAGIC.length + 4 + headerBuf.length + litComp.length,
      copied,
      literal: litRaw.length,
    },
  };
}

function applyPatch(oldBuf, patchBuf) {
  if (patchBuf.length < MAGIC.length + 4 || !patchBuf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('不是鲸鲸的补丁文件');
  }
  const headerLen = patchBuf.readUInt32LE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const header = JSON.parse(patchBuf.subarray(headerStart, headerStart + headerLen).toString('utf8'));
  if (header.format !== 1) throw new Error('补丁格式版本不认识：' + header.format);
  if (oldBuf.length !== header.oldSize) {
    throw new Error('旧包大小不对（' + oldBuf.length + '/' + header.oldSize + '），补丁不能用');
  }
  if (sha256(oldBuf) !== header.oldSha256) throw new Error('旧包校验对不上，补丁不能用');

  const litBuf = zlib.inflateSync(patchBuf.subarray(headerStart + headerLen));
  if (litBuf.length !== header.litSize) throw new Error('字面量解压后大小不对');

  const out = Buffer.alloc(header.newSize);
  let pos = 0;
  for (const op of header.ops) {
    const [kind, off, len] = op;
    if (kind === 'c') {
      if (off + len > oldBuf.length) throw new Error('COPY 越界');
      oldBuf.copy(out, pos, off, off + len);
    } else if (kind === 'l') {
      if (off + len > litBuf.length) throw new Error('字面量越界');
      litBuf.copy(out, pos, off, off + len);
    } else {
      throw new Error('不认识的指令：' + kind);
    }
    pos += len;
  }
  if (pos !== header.newSize) throw new Error('打出来的大小不对（' + pos + '/' + header.newSize + '）');
  if (sha256(out) !== header.newSha256) throw new Error('打出来的校验对不上');
  return out;
}

function makeFile(oldPath, newPath, outPath) {
  const oldBuf = fs.readFileSync(oldPath);
  const newBuf = fs.readFileSync(newPath);
  const { patch, stats } = makePatch(oldBuf, newBuf);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, patch);
  const pct = stats.newSize ? (stats.patchSize * 100 / stats.newSize) : 0;
  console.log(
    '补丁 ' + path.basename(outPath) + '：' + stats.patchSize + ' 字节 / 新包 ' + stats.newSize +
    ' 字节（' + pct.toFixed(1) + '%），COPY ' + stats.copied + '，字面量 ' + stats.literal
  );
  return stats;
}

function applyFile(oldPath, patchPath, outPath) {
  const out = applyPatch(fs.readFileSync(oldPath), fs.readFileSync(patchPath));
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, out);
  console.log('已打出 ' + path.basename(outPath) + '：' + out.length + ' 字节');
  return out;
}

module.exports = { makePatch, applyPatch, chunkBuffer };

if (require.main === module) {
  const [cmd, a, b, c] = process.argv.slice(2);
  try {
    if (cmd === 'make' && a && b && c) makeFile(a, b, c);
    else if (cmd === 'apply' && a && b && c) applyFile(a, b, c);
    else {
      console.error('用法：node scripts/patch.js make <旧文件> <新文件> <输出.patch>');
      console.error('      node scripts/patch.js apply <旧文件> <补丁> <输出文件>');
      process.exit(2);
    }
  } catch (e) {
    console.error('ERR ' + e.message);
    process.exit(1);
  }
}
