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