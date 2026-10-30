'use strict';

/**
 * 一键更新脚本检查。
 *
 * 更新器要动用户的安装目录，所以这里把几条"不能破"的底线钉成静态断言：
 *   1) 覆盖时必须排除 data\（记忆）和 config.json（Key）
 *   2) 绝不能出现 robocopy /MIR —— 那会把用户多的文件（包括 data\）对齐删掉
 *   3) 下载必须按官方 API 给的 sha256 校验
 *   4) 覆盖后自检失败要能自动回滚
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ps1Path = path.join(root, 'scripts', 'update.ps1');
const batPath = path.join(root, '一键更新.bat');

function readPs1() {
  return fs.readFileSync(ps1Path, 'utf8');
}

test('一键更新.bat 存在，并调用 scripts\\update.ps1', () => {
  assert.ok(fs.existsSync(batPath), '缺少 一键更新.bat');
  const text = fs.readFileSync(batPath, 'utf8');
  assert.match(text, /scripts\\update\.ps1/);
  assert.match(text, /ExecutionPolicy Bypass/);
});

test('scripts\\update.ps1 是带 BOM 的 UTF-8（否则 PowerShell 5.1 解析中文会挂）', () => {
  const buf = fs.readFileSync(ps1Path);
  assert.equal(buf[0], 0xef, 'update.ps1 缺 BOM');
  assert.equal(buf[1], 0xbb);
  assert.equal(buf[2], 0xbf);
});

test('覆盖时排除 data\\ 和 config.json（记忆和 Key 不能被碰）', () => {
  const ps1 = readPs1();
  assert.match(ps1, /\$exclDirs = @\('data'/, '覆盖目录白名单里必须有 data');
  assert.match(ps1, /\$exclFiles = @\('config\.json'/, '覆盖文件白名单里必须有 config.json');
});

test('不许用 robocopy /MIR（会连 data\\ 一起镜像删除）', () => {
  const ps1 = readPs1();
  assert.ok(!/\/MIR\b/i.test(ps1), 'update.ps1 出现了 /MIR，必须改成只增不删的 /E');
});

test('下载要按 sha256 校验，对不上就删文件重来', () => {
  const ps1 = readPs1();
  assert.match(ps1, /Get-FileHash[^\r\n]*SHA256/);
  assert.match(ps1, /digest/);
  assert.match(ps1, /sha256 校验不通过|sha256 对不上/);
});

test('覆盖后自检失败要自动回滚', () => {
  const ps1 = readPs1();
  assert.match(ps1, /function Restore-Backup/);
  assert.match(ps1, /已自动回滚到/);
  assert.match(ps1, /function Invoke-RollbackFlow/);
});

test('自检要盯住记忆条数和 config 哈希', () => {
  const ps1 = readPs1();
  assert.match(ps1, /记忆条数变少/);
  assert.match(ps1, /config\.json 被动过了/);
});

test('脚本可以独立运行（不依赖仓库外的 _common.ps1）', () => {
  const ps1 = readPs1();
  assert.doesNotMatch(ps1, /_common\.ps1/);
  assert.match(ps1, /function Get-StoreStats/);
  assert.match(ps1, /function Invoke-Robocopy/);
});

test('官方连不上时有镜像兜底，也可以彻底关掉', () => {
  const ps1 = readPs1();
  assert.match(ps1, /ghfast\.top/);
  assert.match(ps1, /NoMirror/);
});

test('安装目录带 Low 完整性标签时，临时目录要能回退到安装目录里', () => {
  // 现象：E:\ 下解压的目录带 Low 标签，从它启动的 node.exe 也是 Low，
  // 写 %TEMP%（Medium）会 EPERM，下载/解压全挂。所以必须先探测 node 能不能写。
  const ps1 = readPs1();
  assert.match(ps1, /function Test-NodeWritable/);
  assert.match(ps1, /Test-NodeWritable -NodeExe \$nodeExe -Dir \$cand/);
  assert.match(ps1, /backup\\\.update/, '要能退回到安装目录下的 backup\\.update');
});
test('一键更新也管迁移：-Migrate / -FromDir / 搬前备份', () => {
  const ps1 = readPs1();
  assert.match(ps1, /\[switch\]\$Migrate/);
  assert.match(ps1, /\[string\]\$FromDir/);
  assert.match(ps1, /before-migrate-/);
  assert.match(ps1, /当前目录已经有 /, '已有记忆要 -Force 才覆盖');
});

test('旧入口 migrate-data.ps1 只转发，不再有第二份实现', () => {
  const shim = fs.readFileSync(path.join(root, 'scripts', 'migrate-data.ps1'), 'utf8');
  assert.match(shim, /update\.ps1/);
  assert.match(shim, /Migrate/);
  assert.ok(!/robocopy/i.test(shim), 'shim 里不该有复制逻辑');
  assert.ok(shim.split(/\r?\n/).length < 40, 'shim 不该长回一份实现');
});

test('升级到新版本.bat 已并入 一键更新.bat', () => {
  assert.ok(!fs.existsSync(path.join(root, '升级到新版本.bat')));
});

test('Low 标签会先自愈，再决定用哪个临时目录', () => {
  const ps1 = readPs1();
  assert.match(ps1, /setintegritylevel Medium/);
  assert.match(ps1, /Repair-ExeIntegrity/);
});
test('旧安装按最近保存时间排序，而不是消息条数', () => {
  const ps1 = readPs1();
  assert.match(ps1, /SavedAtTime/);
  assert.match(ps1, /Sort-Object -Property SavedAtTime -Descending/);
  assert.ok(!/Sort-Object -Property Messages/.test(ps1), '别再用消息条数当排序依据');
});

test('查版本接口被墙时走 gh-proxy 的 API 转发', () => {
  const ps1 = readPs1();
  assert.match(ps1, /gh-proxy\.com\/https:\/\/api\.github\.com/);
});
test('反代不是只有一个：API 和下载都备了多个', () => {
  const ps1 = readPs1();
  assert.match(ps1, /gh-proxy\.com\/https:\/\/api\.github\.com/);
  assert.match(ps1, /gh-proxy\.org\/https:\/\/api\.github\.com/);
  for (const m of ['ghfast.top', 'gh-proxy.com', 'gh-proxy.org', 'ghproxy.net']) {
    assert.ok(ps1.includes("'" + 'https://' + m + '/'), '下载镜像缺 ' + m);
  }
});

test('所有 API 都挂了，从镜像页面抠版本号兜底', () => {
  const ps1 = readPs1();
  assert.match(ps1, /function Get-LatestTagFromMirror/);
  assert.match(ps1, /releases\/tag\//);
});
test('版本号只要和 latest 不同就更新，不比较大小', () => {
  const ps1 = readPs1();
  assert.match(ps1, /if \(\$cmp -eq 0 -and -not \$Force\)/);
  assert.ok(!/if \(\$cmp -le 0/.test(ps1), '不要再按大小跳过');
});
