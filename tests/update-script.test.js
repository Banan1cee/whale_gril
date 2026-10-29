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
  assert.match(ps1, /if \(\$cmp -eq 0 -and -not \$Force/);
  assert.ok(!/if \(\$cmp -le 0/.test(ps1), '不要再按大小跳过');
});

test('下载要有真进度条：别在下载前把 Write-Progress 一起静音', () => {
  // 现象：旧版在 Save-ReleaseAsset 开头写了 $ProgressPreference = 'SilentlyContinue'，
  // 本意是压 Invoke-WebRequest 自己的进度，结果把自己的进度条也关了 ——
  // 80MB 的包下几分钟，屏幕上什么都不动，用户以为卡死。
  const ps1 = readPs1();
  assert.match(ps1, /Write-Progress -Activity \$Activity -Status \$Status -PercentComplete \$Percent/);
  const fnStart = ps1.indexOf('function Save-ReleaseAsset');
  const nodeCall = ps1.indexOf("& $node $Helper 'download'", fnStart);
  assert.ok(fnStart > 0 && nodeCall > fnStart, 'Save-ReleaseAsset 里找不到下载调用');
  const head = ps1.slice(fnStart, nodeCall);
  assert.ok(!/ProgressPreference\s*=\s*'SilentlyContinue'/.test(head),
    '下载开始前就静音了进度条，用户只能干等');
  // 静音只能出现在 Invoke-WebRequest 兜底分支里
  const silentAt = ps1.indexOf("$ProgressPreference = 'SilentlyContinue'");
  assert.ok(silentAt > 0, 'IWR 兜底分支仍然要静音（5.1 下它会拖慢下载）');
  assert.match(ps1.slice(silentAt, silentAt + 400), /Invoke-WebRequest/, '静音要贴着 Invoke-WebRequest，别扩大范围');
});

test('下载进度：百分比 + 已下载/总大小 + 速度 + 剩余时间', () => {
  const ps1 = readPs1();
  assert.match(ps1, /console\.log\('S ' \+ \(total > 0 \? total : 0\)\)/, 'helper 要先报总大小');
  assert.match(ps1, /console\.log\('P ' \+ pct/, 'helper 要按百分比报告');
  assert.match(ps1, /Math\.round\(\(total - got\) \/ speed\)/, '要算剩余时间');
  // PS 侧按空格拆的固定格式解析；用 includes 比对，比转义正则清楚
  const pLine = "'^P (\\d+) ([\\d\\.]+) ([\\d\\.]+) (\\S+) (-?\\d+)$'";
  assert.ok(ps1.includes(pLine), 'PS 侧要按新格式解析进度行');
  assert.match(ps1, /function Format-Eta/);
  assert.match(ps1, /MB\/s/);
  assert.match(ps1, /KB\/s/, '慢速源要显示 KB/s，别糊成 0.0 MB/s');
});

test('镜像不回 content-length 时也要有输出，不能一片死寂', () => {
  const ps1 = readPs1();
  assert.match(ps1, /console\.log\('B ' \+ mb\(got\) \+ ' ' \+ speedText\(speed\)\)/, 'helper 要有未知总大小的兜底行');
  assert.ok(ps1.includes("'^B ([\\d\\.]+) (\\S+)$'"), 'PS 侧要解析兜底行');
  assert.match(ps1, /已下载 ' \+ \$matches\[1\]/, '兜底时至少要显示已下载多少');
});

test('输出被重定向时进度降级成文本，不去碰 console buffer', () => {
  const ps1 = readPs1();
  assert.match(ps1, /\$script:ProgressTextPct/);
  assert.match(ps1, /if \(\$script:UseProgress\) \{/, '有窗口才用 Write-Progress');
  assert.match(ps1, /每 5 秒/, '未知总大小时按时间打点');
});

test('下载太慢自动换源：10 秒不到 200KB 就放弃这个源', () => {
  const ps1 = readPs1();
  assert.match(ps1, /\$script:SlowWindowMs = 10000/);
  assert.match(ps1, /\$script:SlowMinBytes = 200 \* 1024/);
  // helper 里按已下字节数判死，别让用户盯着 20KB/s 等十分钟
  assert.match(ps1, /const slowMs = Number\(process\.argv\[5\]/, 'helper 要接收限速参数');
  assert.match(ps1, /if \(got < slowMin\)/, '到点还没下够就放弃');
  assert.match(ps1, /console\.log\('SLOW ' \+ got/, 'helper 要报 SLOW 给上层');
  // PS 侧要认 SLOW 并把 URL 记下来
  assert.match(ps1, /\^SLOW \(\\d\+\) \(\\d\+\)\$/, 'PS 要解析 SLOW 行');
  assert.match(ps1, /\$slowBest = \[pscustomobject\]@\{ Url = \$u; Got = \$slowGot \}/);
  assert.match(ps1, /NoSlowGuard/, '所有源都太慢时要能挑最快的那个再试一次');
});

test('同版本双击不再只会退出：问一句，回车退出、r 重装', () => {
  const ps1 = readPs1();
  // 只有非交互（重定向 / -Yes）才保持"直接退出"，平时要问
  assert.match(ps1, /if \(-not \$CanPrompt\) \{[\s\S]{0,200}想强制重装同一版请加 -Force/);
  assert.match(ps1, /\[r\] 重装这一版/, '要告诉用户 r 是重装');
  assert.match(ps1, /if \(\$pick -notmatch '\^\\s\*\[rR\]'\)/, 'r 之外都算取消');
  assert.match(ps1, /\$script:Reinstall = \(\$cmp -eq 0\)/);
  assert.match(ps1, /if \(\$cmp -eq 0 -and -not \$Force -and -not \$Check -and -not \$DryRun\)/,
    '-Check / -DryRun 不该弹这个问句');
});

test('重装模式要真能补文件：报缺了什么，并把 runtime 整块重铺', () => {
  const ps1 = readPs1();
  assert.match(ps1, /function Get-MissingFromPackage/);
  assert.match(ps1, /本地缺 ' \+ \$missFiles\.Count \+ ' 个文件/);
  assert.match(ps1, /-and -not \$script:Reinstall\)/, '重装时不能因为 node.exe 一样就跳过 runtime');
  assert.match(ps1, /'重装完成：' \+ \$newVer/);
});

test('下载前先给每个源测速，谁快用谁（5 秒，并发，不落盘）', () => {
  const ps1 = readPs1();
  assert.match(ps1, /\$script:ProbeBudgetMs = 5000/);
  assert.match(ps1, /function Get-BestDownloadOrder/);
  // helper 侧：probe 模式并发跑，只数字节
  assert.match(ps1, /if \(mode === 'probe'\)/, 'helper 要有 probe 模式');
  assert.match(ps1, /Promise\.all\(urls\.map\(\(u\) => probeOne/, '测速要并发，别串行等 5×N 秒');
  assert.match(ps1, /bytes >= capBytes/, '测速要设上限，别为了测速把整个包下完');
  assert.ok(!/function probeOne[\s\S]{0,900}createWriteStream/.test(ps1), '测速不该往磁盘写东西');
  // PS 侧：按实测速度排序，且最快那个排第一
  assert.ok(ps1.includes('Sort-Object -Property @{ Expression = { $_.Speed }; Descending = $true }'),
    '要按实测速度倒序排，最快的排第一');
  assert.match(ps1, /秒，谁快用谁/, '要告诉用户正在测速');
  // 只有一个源时别浪费 5 秒
  assert.match(ps1, /if \(\$list\.Count -lt 2\) \{ return \$list \}/);
  // 测速挑完，慢速兜底逻辑还在
  assert.match(ps1, /Get-BestDownloadOrder -Urls \$urls/);
});

test('安装包去留：只在这次真下过包时问一句（回车删 / r 留）', () => {
  const ps1 = readPs1();
  assert.match(ps1, /\$keepThisZip = \$KeepZip/, '保留决策从 -KeepZip 起算');
  assert.match(ps1, /if \(-not \$keepThisZip -and \$needDownload -and \$CanPrompt/,
    '只有真下过包、且有控制台才问');
  assert.match(ps1, /安装包要留着吗/, '要问一句留不留');
  assert.match(ps1, /\$keepAns -match '\^\\s\*\[rR\]'/, 'r = 留着，其他（含回车）= 删掉');
  assert.ok(!/if \(-not \$KeepZip\) \{ Remove-Item -LiteralPath \$zipPath/.test(ps1),
    '别再用「不是 -KeepZip 就一律删」');
});



