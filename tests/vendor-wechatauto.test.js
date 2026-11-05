'use strict';

/**
 * vendor/wechatauto 门禁：固定进仓库的上游包必须自洽，且构建必须真的用它。
 *
 * 为什么要有这组断言：
 *   1. MANIFEST 是构建期唯一的完整性凭据。清单和文件对不上（多、少、改了内容），
 *      build-runtime.ps1 会 fail —— 但那只在构建机上跑；CI 里也要有一条，
 *      免得清单过期很久才被发现。
 *   2. .pyc 绝不能入库：Python 版本一变就会加载旧字节码，症状是「源码明明改了却不生效」。
 *   3. vendored 源码里不许出现 URL：防上游哪天塞进遥测 / 版本检查 / 自动更新。
 *   4. 构建脚本必须从 vendor 复制，而不是回头去 pip download 这个包。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'vendor');
const pkg = path.join(vendor, 'wechatauto');
const manifestPath = path.join(vendor, 'MANIFEST.sha256');

/** 递归列出 vendor/wechatauto 下的文件（相对 vendor/ 的 POSIX 路径） */
function listVendorFiles(dir = pkg) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else out.push(path.relative(vendor, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

function readManifest() {
  const text = fs.readFileSync(manifestPath, 'utf8');
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f]{64})  (.+)$/);
    assert.ok(m, 'MANIFEST 行格式必须是「<sha256>  <相对路径>」：' + line);
    map.set(m[2], m[1]);
  }
  return map;
}

test('vendor/wechatauto 已入库，且有 MANIFEST', () => {
  assert.ok(fs.existsSync(path.join(pkg, '__init__.py')), '缺少 vendor/wechatauto/__init__.py');
  assert.ok(fs.existsSync(manifestPath), '缺少 vendor/MANIFEST.sha256');
  assert.ok(fs.existsSync(path.join(vendor, 'README.md')), '缺少 vendor/README.md（说明来源与升级流程）');
});

test('vendored 文件与 MANIFEST.sha256 完全一致（多一个、少一个、改了内容都红）', () => {
  const expected = readManifest();
  const actual = listVendorFiles();
  assert.deepEqual(actual, [...expected.keys()].sort(), '实际文件清单与 MANIFEST 不一致');
  for (const rel of actual) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(vendor, rel))).digest('hex');
    assert.equal(hash, expected.get(rel), rel + ' 的哈希与 MANIFEST 对不上');
  }
});

test('vendor 下没有 .pyc、也没有 __pycache__', () => {
  const bad = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '__pycache__') bad.push(path.relative(root, full));
        else walk(full);
      } else if (ent.name.endsWith('.pyc')) {
        bad.push(path.relative(root, full));
      }
    }
  };
  walk(vendor);
  assert.deepEqual(bad, [], 'vendor 里不该有字节码：' + bad.join('、'));
});

test('dist-info 齐全：METADATA 有 Version，licenses 非空', () => {
  const distInfo = path.join(pkg, 'dist-info');
  const metadata = path.join(distInfo, 'METADATA');
  assert.ok(fs.existsSync(metadata), '缺少 dist-info/METADATA');
  const text = fs.readFileSync(metadata, 'utf8');
  assert.match(text, /^Name: wechatauto-replica$/m, 'METADATA 的包名不对');
  assert.match(text, /^Version: 1\.2\.9$/m, 'METADATA 的版本应是 1.2.9');
  for (const f of ['WHEEL', 'RECORD', 'entry_points.txt', 'top_level.txt']) {
    assert.ok(fs.existsSync(path.join(distInfo, f)), '缺少 dist-info/' + f);
  }
  const licenses = path.join(distInfo, 'licenses');
  assert.ok(fs.existsSync(licenses), '缺少 dist-info/licenses');
  assert.ok(fs.readdirSync(licenses).length > 0, 'dist-info/licenses 不该是空目录');
});

test('requirements.txt 不再要求 wechatauto-replica（改由 vendor 提供）', () => {
  const text = fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8');
  assert.doesNotMatch(text, /^\s*wechatauto-replica\b/m, 'requirements.txt 还在装 wechatauto-replica');
  assert.match(text, /vendor\/wechatauto/, '要有一句指向 vendor 的说明');
  // 其余依赖必须精确锁定，不能 >= 浮动
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.trim()) continue;
    assert.match(line, /^[A-Za-z0-9_.\-]+==[0-9][0-9A-Za-z.\-]*$/, '依赖必须精确锁定：' + line);
  }
});

test('build-runtime.ps1 从 vendor/wechatauto 复制，且不再 pip download 它', () => {
  const text = fs.readFileSync(path.join(root, 'scripts', 'build-runtime.ps1'), 'utf8');
  assert.match(text, /vendor\\wechatauto/, '构建脚本要引用 vendor\\wechatauto');
  assert.match(text, /MANIFEST\.sha256/, '构建脚本要先校验 MANIFEST');
  assert.doesNotMatch(text, /\$Packages\s*=\s*@\([^)]*wechatauto-replica/, '$Packages 里不该再有 wechatauto-replica');
  assert.doesNotMatch(text, /pip download[^\r\n]*wechatauto/i, '不该再对这个包执行 pip download');
});

test('vendored .py 里没有任何网络地址（防上游塞遥测 / 版本检查）', () => {
  const hits = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.py')) {
        const text = fs.readFileSync(full, 'utf8');
        if (/https?:\/\/|github\.com|pypi\.org/i.test(text)) {
          hits.push(path.relative(root, full));
        }
      }
    }
  };
  walk(pkg);
  assert.deepEqual(hits, [], 'vendored 源码里出现了网络地址：' + hits.join('、'));
});
