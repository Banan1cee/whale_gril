'use strict';

/**
 * 更新链路契约测试。
 *
 * 起因：安装版点更新永远报「没找到 scripts\update.ps1」——
 *   · 安装包的 [Files] 不带 scripts\，装完目录里根本没有那个脚本；
 *   · 就算带上也没用：脚本只认 Release 里的 zip 资产，而 CI 从 4.0.1 起只传 setup.exe；
 *   · 另外 Release 里没有 release-manifest.json，客户端只能靠 raw 分支兜底。
 *
 * 这里只读文件、不联网：更新落地方式或资产名一改错，测试直接红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const service = read('launcher/UpdateService.cs');
const manifestCode = read('launcher/UpdateManifest.cs');
const iss = read('installer/whale.iss');
const wf = read('.github/workflows/installer.yml');
const manifest = JSON.parse(read('release-manifest.json'));

test('UpdateService：有脚本才走脚本，没有就下载安装包（不是硬依赖）', () => {
  assert.match(service, /if\s*\(File\.Exists\(script\)\)/, 'ApplyAsync 没有先判断 scripts\\update.ps1 是否存在');
  assert.match(service, /SetupAsync\(/, '没有安装包覆盖安装这条新路');
  assert.ok(!service.includes('没找到 scripts'), '安装版还会直接报「没找到 scripts\\update.ps1」');
  // 源码版的路必须留着：不恢复 zip 分发，也不删 update.ps1
  assert.match(service, /ApplyByScriptAsync\(/, '源码版的 update.ps1 分支被删了');
  assert.ok(fs.existsSync(path.join(root, 'scripts/update.ps1')), 'scripts/update.ps1 被删了（源码版还要用）');
});

test('UpdateService：从 releases/latest/download 取安装包和校验清单', () => {
  assert.ok(service.includes('releases/latest/download'), '没有走 releases/latest/download');
  assert.ok(service.includes('SHA256SUMS.txt'), '没有下载 SHA256SUMS.txt');
  assert.ok(service.includes('Banan1cee/whale_gril'), '仓库地址不对');
  // 不调 GitHub API：未认证限流会直接把更新卡死
  assert.ok(!service.includes('api.github.com'), '又回去调 GitHub API 了（未认证会限流）');
});

test('UpdateService：静默安装参数是 /SILENT，带 /CLOSEAPPLICATIONS', () => {
  assert.ok(service.includes("'/SILENT'"), '安装参数不是 /SILENT（/VERYSILENT 会让用户看不到进度）');
  assert.ok(!service.includes("'/VERYSILENT'"), '用了 /VERYSILENT，用户看不到安装进度');
  assert.ok(service.includes('/CLOSEAPPLICATIONS'), '没有 /CLOSEAPPLICATIONS，启动器自己占着 exe 会装不上');
  assert.ok(service.includes('/NORESTART'), '没有 /NORESTART，静默安装可能直接重启电脑');
});

test('UpdateService：装完自己退出并重启，不跟安装器抢 exe', () => {
  assert.ok(service.includes('UseShellExecute = true'), 'apply.ps1 没有独立进程启动，启动器一退就断了');
  assert.ok(service.includes('ApplyOutcome'), '没有把「已交给安装器」回传给 MainWindow');
  const main = read('launcher/MainWindow.xaml.cs');
  assert.ok(main.includes('HandedToInstaller'), 'MainWindow 没处理「已交给安装器」，会自己再拉起旧 exe');
  assert.ok(main.includes('Application.Current.Shutdown()'), '装完后没有退出，exe 换不掉');
});

test('安装包资产名：iss 与 UpdateService 拼出来的一致', () => {
  assert.match(iss, /^OutputBaseFilename=whale-girl-\{#AppVersion\}-setup$/m, 'iss 的产物名变了');
  assert.ok(service.includes('"whale-girl-" + latest + "-setup.exe"'), 'UpdateService 拼的资产名和 iss 不一致');
});

test('UpdateService：下载跟随系统代理，检测仍然直连', () => {
  // 国内用户基本都挂代理；下载 176MB 走直连必然失败，所以下载必须 UseProxy=true
  assert.ok(/UseProxy = true/.test(service), '下载用的 HttpClient 没有跟随系统代理');
  // 检测（UpdateManifest）保持直连：启动不能被代理拖住，快速失败更重要
  assert.ok(/UseProxy = false/.test(manifestCode), 'UpdateManifest 的直连检测被改了');
  const falseUses = [
    ...(service.match(/UseProxy\s*=\s*false/g) || []),
  ];
  assert.equal(falseUses.length, 0, 'UpdateService 里还有 UseProxy = false');
  assert.ok(service.includes('放行 github.com'), '下载失败文案没有提示代理放行');
});

test('强制态更新失败后必须真的拦住（不许弹个框就让人继续用）', () => {
  const main = read('launcher/MainWindow.xaml.cs');
  // 失败分支里：非交互（强制）时提示完直接退出
  const start = main.indexOf('if (!outcome.Ok)');
  assert.ok(start > 0, '找不到更新失败分支');
  const block = main.slice(start, main.indexOf('// 安装版：apply.ps1', start));
  assert.ok(/if \(!askFirst\)/.test(block), '强制态失败没有单独处理，会放行');
  assert.ok(block.includes('MessageBox.Show'), '强制态失败没有提示原因');
  assert.ok(
    block.slice(block.indexOf('if (!askFirst)')).includes('Application.Current.Shutdown()'),
    '强制态更新失败后没有退出——等于没强制'
  );
  // 死代码清干净：强制小窗不再有调用方，留着会让人以为还能接回去
  assert.ok(!main.includes('ShowForceDialog'), 'ShowForceDialog 还在，会误导后来的人');
});

test('Release 资产包含 release-manifest.json，并且建完会回读', () => {
  const start = wf.indexOf('创建 GitHub Release');
  assert.ok(start > 0, 'installer.yml 没有创建 Release 的步骤');
  const block = wf.slice(start);
  assert.ok(block.includes('release-manifest.json'), 'Release 资产里没有 release-manifest.json');
  assert.ok(
    /gh release create[^\n]*\$manifestPath/.test(block),
    'gh release create 没有把 manifest 作为资产传上去'
  );
  assert.ok(
    block.includes('gh release upload') && /gh release upload[^\n]*\$manifestPath/.test(block),
    '覆盖上传时漏了 release-manifest.json'
  );
  assert.ok(block.includes('gh release view'), '建完没有回读资产列表');
  assert.ok(block.includes("'release-manifest.json'"), '回读断言里没检查 manifest');
});

test('发版步骤会写 latest / released_at / manifest_version', () => {
  const start = wf.indexOf('创建 GitHub Release');
  const block = wf.slice(start);
  for (const needle of ['$manifest.latest = $env:version', 'released_at', '$manifest.manifest_version', 'force_after_hours']) {
    // force_after_hours 由仓库里的清单原样带过去（只读不改）
    assert.ok(block.includes(needle) || read('release-manifest.json').includes('force_after_hours'), `发版步骤没有处理 ${needle}`);
  }
  assert.ok(block.includes('$manifest.manifest_version = [int]$manifest.manifest_version + 1'), 'manifest_version 没有递增');
});

test('release-manifest.json 的字段与 UpdateManifest.Parse 一一对应', () => {
  const fields = ['latest', 'released_at', 'force_after_hours', 'force', 'kill_below', 'message', 'manifest_version'];
  for (const f of fields) {
    assert.ok(Object.prototype.hasOwnProperty.call(manifest, f), `release-manifest.json 缺字段 ${f}`);
    assert.ok(manifestCode.includes(`"${f}"`), `UpdateManifest.cs 没有解析 ${f}`);
  }
  assert.ok(manifest.latest.length > 0, 'latest 是空的，客户端永远显示已是最新');
  assert.equal(typeof manifest.manifest_version, 'number', 'manifest_version 必须是数字（多源比较用）');
});

/**
 * 清单有 4 个源（含两个镜像），所以「检查更新」总能拿到版本号；
 * 但资产以前只有 GitHub 一条路，国内直连 TLS 直接断，于是卡在
 * 「下载校验清单失败」——知道有新版本，却一个字节都下不来。
 */
test('UpdateService：资产（安装包 / 校验清单）有镜像回退，直连排在第一位', () => {
  const start = service.indexOf('private static readonly string[] AssetBases');
  assert.ok(start > 0, '没有资产源列表 AssetBases');
  const block = service.slice(start, service.indexOf('};', start));

  for (const host of ['gh-proxy.com', 'ghfast.top', 'ghproxy.net']) {
    assert.ok(block.includes(host), `资产源里缺镜像 ${host}（与 scripts/update.ps1 用过的三家保持一致）`);
  }
  assert.ok(block.includes('https://github.com/'), '资产源里没有 GitHub 直连');
  assert.ok(
    block.indexOf('https://github.com/') < block.indexOf('gh-proxy.com'),
    '镜像排到了直连前面：官方源能用时不该先走第三方'
  );
});

test('UpdateService：校验清单多源并行，哈希对不上就中止而不是挑一个用', () => {
  assert.match(service, /Task\.WhenAll\(AssetBases\.Select/, '校验清单没有多源并行拉取');
  assert.match(service, /不一致，已中止/, '多个源的哈希冲突时没有中止（会装到被篡改的包）');
  assert.match(service, /hash\.Length == 64/, '没有校验哈希格式，镜像的错误页会被当成哈希');
});

test('UpdateService：安装包 4 段并发，服务端不支持 Range 就退回单连接', () => {
  assert.ok(service.includes('RangeHeaderValue'), '没有用 Range 分段下载');
  assert.match(service, /SegmentCount = 4/, '分段数不是 4');
  assert.match(service, /HttpStatusCode\.PartialContent/, '没有检查 206（Range 是否真的被支持）');
  assert.match(service, /ProbeLengthAsync/, '没有先探总长度就直接分段');
  assert.match(
    service,
    /DownloadSegmentsAsync\([^;]*\)\)[\s\S]{0,120}return await DownloadSingleAsync/,
    '分段失败后没有回退单连接'
  );
});

test('UpdateService：单个源失败不影响整体——换源，并把每个源的原因汇总报出来', () => {
  assert.match(service, /foreach \(var baseUrl in AssetBases\)/, '没有逐源尝试');
  assert.match(service, /tried\.Add\(/, '没有记录每个源的失败原因');
  assert.ok(service.includes('的 SHA256 对不上'), '哈希不符时直接判死，没有换下一个源');
  assert.match(service, /string\.Join\("；", tried\)/, '全部失败时没有把原因汇总给用户');
});
