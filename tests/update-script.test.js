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

test('运行中的启动器不参与覆盖，改成「改名 → 落位」换掉', () => {
  // 现象：从启动器里点更新，最后一个文件是它自己，写不进去 → robocopy 退出码 8 → 整包回滚。
  // Windows 允许给运行中的 exe 改名（不允许写/删），所以换成先改名腾路径再落位。
  const ps1 = readPs1();
  assert.match(ps1, /\[string\]\$ExeName/, '缺 -ExeName 参数');
  assert.match(ps1, /function Get-RunningExeName/, '要能自动探测正在运行的 exe，名字不能写死');
  assert.match(ps1, /function Swap-AppExe/, '缺换 exe 的实现');
  assert.match(ps1, /\$exclFiles \+= \$exeName/, '正在运行的 exe 必须从覆盖列表里排除');
  assert.match(ps1, /Rename-Item -LiteralPath \$cur -NewName/, '运行中的 exe 只能改名，不能覆盖');
  assert.match(ps1, /Rename-Item -LiteralPath \$old -NewName \$ExeName/, '落位失败要把旧文件改回来');
});

test('换 exe 失败不算更新失败（否则又会整包回滚）', () => {
  const ps1 = readPs1();
  const start = ps1.indexOf('# ---- 换启动器自己 ----');
  const end = ps1.indexOf('# ---- 收尾 ----');
  assert.ok(start > 0 && end > start, '找不到换 exe 的段落');
  const block = ps1.slice(start, end);
  assert.match(block, /catch \{[\s\S]*代码已更新/, '换不掉要提示手动替换');
  assert.ok(!/throw/.test(block), '换 exe 的段落里不能 throw，否则会把已更新的代码回滚掉');
});

test('下载支持分段并发，不支持 Range 时退回单连接', () => {
  const ps1 = readPs1();
  assert.match(ps1, /\[int\]\$Connections/, '缺 -Connections 参数');
  assert.match(ps1, /\[switch\]\$NoParallel/, '缺 -NoParallel 开关');
  assert.match(ps1, /content-range/i, '要按 Content-Range 拿总长度');
  assert.match(ps1, /Range: 'bytes=' \+ pos/, '分片要带 Range 头');
  assert.match(ps1, /downloadMulti/, '缺多连接实现');
  assert.match(ps1, /fetchSegment/, '缺分片重试');
  assert.match(ps1, /downloadSingle\(probe, out\)/, '不支持 Range 时要拿探测到的 200 响应当单连接');
  assert.match(ps1, /'download' \$u \$Dest \$script:conns/, '要把并发数传给 helper');
});

test('差分更新：有上一版缓存和对应补丁，就只下补丁', () => {
  const ps1 = readPs1();
  assert.match(ps1, /\[switch\]\$NoPatch/, '缺 -NoPatch 开关');
  assert.match(ps1, /\\\.patch\$/, '要按 .patch 资产名认补丁');
  assert.match(ps1, /-from-/, '补丁资产名要带 from-<旧版本>，避免拿错补丁');
  assert.match(ps1, /scripts\\patch\.js/, '客户端要用 scripts\\patch.js 打补丁');
  assert.match(ps1, /差分更新成功/, '要明确告诉用户这次只下了补丁');
  assert.match(ps1, /改下整包/, '补丁失败必须回退到整包，不能直接失败');
  assert.match(ps1, /打完补丁和官方包对不上/, '打完补丁仍要按官方 sha256 校验');
});

test('更新完把这次的 zip 留在 cache 里（下次差分要用）', () => {
  const ps1 = readPs1();
  assert.match(ps1, /Get-ChildItem -LiteralPath \$cacheDir -Filter '\*\.zip'/, 'cache 里要保留最新一份 zip');
  assert.ok(!/if \(-not \$KeepZip\) \{ Remove-Item -LiteralPath \$zipPath/.test(ps1), '不能下完就把 zip 删掉');
});

test('换完 exe 要把旧的删干净，不能越更新越占地方', () => {
  const ps1 = readPs1();
  // 运行中删不掉（OS 限制）→ 留 .old-*；但只要没进程占着就必须当场删掉
  assert.match(ps1, /Remove-Item -LiteralPath \$old -Force -ErrorAction Stop/, '没被占用时要当场删掉旧 exe');
  assert.match(ps1, /Filter \(\$ExeName \+ '\.old-\*'\)/, '历史 .old-* 也要顺手清');
  const app = fs.readFileSync(path.join(root, 'launcher', 'App.xaml.cs'), 'utf8');
  assert.match(app, /GetFiles\(AppContext\.BaseDirectory, "\*\.old-\*"\)/, '启动时要扫一遍 .old-*');
  assert.match(app, /for \(var i = 0; i < 5; i\+\+\)/, '刚退出的旧实例可能还没释放句柄，要重试');
});

test('启动器重启用真实路径，并等旧实例退出再抢单实例锁', () => {
  const main = fs.readFileSync(path.join(root, 'launcher', 'MainWindow.xaml.cs'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'launcher', 'App.xaml.cs'), 'utf8');
  const svc = fs.readFileSync(path.join(root, 'launcher', 'UpdateService.cs'), 'utf8');
  assert.match(main, /Environment\.ProcessPath/, '重启不能写死 WhaleLauncher.exe（以后会改名）');
  assert.match(main, /--replace/, '重启要带 --replace <pid>');
  assert.match(main, /正在重启/, '更新完要自动重启，不能只留个提示');
  assert.ok(!/现在重启吗/.test(main), '不该再弹「现在重启吗」让用户点（以后没有 bat，全靠自动）');
  assert.match(main, /private bool RestartSelf\(out string error\)/, '重启失败要能回报给调用方');
  assert.match(app, /WaitForReplacedInstance/, '新实例要先等旧实例退出，否则弹「已经在运行」');
  assert.match(app, /CleanupOldExes/, '启动时清理 *.old-*');
  assert.match(svc, /-ExeName/, '更新时要告诉脚本当前 exe 名');
});
