'use strict';

/**
 * 安装包契约测试（VB-CABLE 位置 + 覆盖升级 + 旧版残留清理）。
 *
 * 起因：
 *   · 安装包被 [Files] 的 "..\runtime\*" 递归整棵拷进 {app}\runtime，声卡包埋在
 *     {app}\runtime\vb-cable 里，用户装完根本找不到；
 *   · 老版本用 personas\ / resources\，4.0 改成 assets\，覆盖安装后旧目录还留着；
 *   · 升级时鲸鲸正开着，WhaleLauncher.exe 被占用，Inno 写文件失败直接中止。
 *
 * 这里只读文件、不跑 Inno：位置或清理规则改错，测试直接红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const iss = read('installer/whale.iss');
const page = read('launcher/Views/VoiceSendPage.cs');
const guide = read('launcher/Views/VoiceSendGuide.cs');
const wf = read('.github/workflows/installer.yml');
const fetch = read('scripts/fetch-vb-cable.ps1');

const FOLDER = 'VB-CABLE虚拟声卡';
const EXE = 'VBCABLE_Setup_x64.exe';

function section(name) {
  const start = iss.indexOf(`[${name}]`);
  assert.ok(start >= 0, `whale.iss 里没有 [${name}] 段`);
  const rest = iss.slice(start + name.length + 2);
  const end = rest.search(/\r?\n\[/);
  return end >= 0 ? rest.slice(0, end) : rest;
}

test('whale.iss：声卡包整文件夹装到安装目录根部', () => {
  assert.ok(iss.includes(`DestDir: "{app}\\${FOLDER}"`), '没有把声卡包装到 {app}\\VB-CABLE虚拟声卡');
  const files = section('Files');
  const start = files.indexOf('Source: "..\\runtime\\vb-cable\\*"');
  assert.ok(start >= 0, '[Files] 里没有 ..\\runtime\\vb-cable\\* 这一条');
  const entry = files.slice(start, files.indexOf('Source:', start + 10));
  assert.match(entry, /recursesubdirs\s+createallsubdirs/, '声卡包没有递归整棵拷（Pack45 缺一个文件就可能装不上）');
});

test('whale.iss：runtime 那条排除 vb-cable，包里不留两份', () => {
  const files = section('Files');
  const start = files.indexOf('Source: "..\\runtime\\*"');
  assert.ok(start > 0, '[Files] 里没有 ..\\runtime\\* 这一条');
  const entry = files.slice(start, files.indexOf('Source:', start + 10));
  assert.ok(entry.includes('vb-cable\\*'), 'runtime 条目的 Excludes 没排掉 vb-cable\\*，声卡包装了两份');
});

test('whale.iss：指向声卡 exe 的路径都在新文件夹', () => {
  const exeLines = iss.split(/\r?\n/).filter((l) => l.includes(EXE) && !l.trim().startsWith(';'));
  assert.ok(exeLines.length > 0, 'whale.iss 里没有 VBCABLE_Setup_x64.exe');
  for (const line of exeLines) {
    assert.ok(line.includes(FOLDER), `指向声卡 exe 的路径不在 ${FOLDER} 文件夹里：${line.trim()}`);
    assert.ok(!line.includes('runtime\\vb-cable'), `声卡 exe 仍然指向旧的 runtime\\vb-cable：${line.trim()}`);
  }
});

test('whale.iss：[InstallDelete] 清掉 4.0.1 才有的文件', () => {
  const del = section('InstallDelete');
  for (const name of ['personas', 'resources']) {
    assert.ok(
      new RegExp(`Type:\\s*filesandordirs;\\s*Name:\\s*"\\{app\\}\\\\${name}"`).test(del),
      `[InstallDelete] 没有整目录删 {app}\\${name}`
    );
  }
  for (const rel of ['src\\http\\static.js', 'src\\adapters\\bilibili.js']) {
    assert.ok(del.includes(`Type: files; Name: "{app}\\${rel}"`), `[InstallDelete] 没有删 ${rel}`);
  }
  assert.ok(
    del.includes('Type: filesandordirs; Name: "{app}\\runtime\\vb-cable"'),
    '[InstallDelete] 没有清掉旧位置的 runtime\\vb-cable'
  );
  // InstallDelete 只清文件；runtime 那条带 createallsubdirs，装文件时会把空目录建回来，
  // 所以安装末尾还得再删一次，否则升级完目录里留一个空的 runtime\vb-cable。
  assert.ok(
    /DelTree\(ExpandConstant\('\{app\}\\runtime\\vb-cable'\)/.test(iss),
    'ssPostInstall 没有清掉被 createallsubdirs 重建出来的空 runtime\\vb-cable'
  );
});

test('whale.iss：[InstallDelete] 不碰用户数据与运行期库', () => {
  const del = section('InstallDelete').toLowerCase();
  for (const bad of ['data', 'config.json', 'backup', 'wechatauto_db', 'wechatauto_logs']) {
    assert.ok(!del.includes(bad), `[InstallDelete] 里出现了 ${bad}，升级会删用户数据`);
  }
  // 整目录删 src / bridge / runtime 会让安装器删不掉正在使用的文件，直接失败
  for (const dir of ['"{app}\\src"', '"{app}\\bridge"', '"{app}\\runtime"']) {
    assert.ok(!del.includes(`name: ${dir}`), `[InstallDelete] 整目录删了 ${dir}`);
  }
});

test('whale.iss：覆盖安装三件套（占用检测 / 沿用原目录 / 不重复拉起）', () => {
  assert.match(iss, /^CloseApplications=yes$/m, '缺 CloseApplications=yes，鲸鲸开着就装不上');
  assert.match(iss, /^RestartApplications=no$/m, 'RestartApplications 必须是 no，否则装完会开两个启动器');
  assert.match(iss, /^UsePreviousAppDir=yes$/m, '缺 UsePreviousAppDir=yes，改过目录的老用户会多装一份');
  // 这三样是「认作同一个程序」的依据，动了就变成并行安装两份
  assert.match(iss, /^AppId=\{\{7C1E2A54-9B3D-4E88-9A21-5D6F0C4B1A77\}$/m, 'AppId 被改了');
  assert.match(iss, /^PrivilegesRequired=lowest$/m, 'PrivilegesRequired 被改了（会变成要 UAC 的另一种安装）');
});

test('启动器：先找新位置，再兜底旧安装位置', () => {
  assert.ok(page.includes(`Path.Combine(root,"${FOLDER}","${EXE}")`), 'VoiceSendPage.cs 没有优先找新位置的 exe');
  assert.ok(page.includes('Path.Combine(root,"runtime","vb-cable"'), 'VoiceSendPage.cs 没保留 4.0.4 及更早安装位置的兜底');
  assert.ok(page.includes('安装目录\\\\' + FOLDER + '\\\\' + EXE), '找不到驱动时没告诉用户准确位置');
  assert.ok(page.includes('https://vb-audio.com/Cable/'), '找不到驱动时没给官网退路');
});

test('教程：两处提到声卡安装包时都说明在新文件夹', () => {
  assert.ok(guide.includes('包内已附 VB-CABLE 安装程序，装完就在安装目录的 ' + FOLDER), '未展开的入口说明没提新位置');
  assert.ok(guide.includes(`包内那份在安装目录的 ${FOLDER} 文件夹里`), '第 1 步的兜底说明没提新位置');
});

test('安装烟测：期望清单含新位置，且断言 runtime 里没有第二份', () => {
  const start = wf.indexOf('$expect = @(');
  assert.ok(start > 0, '烟测里没有 $expect 清单');
  const block = wf.slice(start, wf.indexOf('$missing', start));
  assert.ok(block.includes(`${FOLDER}\\${EXE}`), `烟测期望清单没有 ${FOLDER}\\${EXE}`);
  assert.ok(block.includes(`${FOLDER}\\readme.txt`), `烟测期望清单没有 ${FOLDER}\\readme.txt`);
  assert.ok(
    wf.includes("Test-Path (Join-Path $dir 'runtime\\vb-cable\\VBCABLE_Setup_x64.exe')"),
    '烟测没有反向断言 runtime\\vb-cable 里不该再有 exe'
  );
});

test('CI：有覆盖升级烟测，且断言用户数据还在', () => {
  assert.ok(wf.includes('覆盖升级烟测'), 'installer.yml 里没有覆盖升级烟测');
  const start = wf.indexOf('覆盖升级烟测');
  const block = wf.slice(start);
  assert.ok(block.includes('data\\keep-me.txt'), '覆盖升级烟测没有放 data 探针文件');
  assert.ok(/Test-Path "\$dir\\data\\keep-me\.txt"/.test(block), '覆盖升级烟测没有断言 data 探针还在');
  assert.ok(block.includes('config.json'), '覆盖升级烟测没有检查 config.json');
  assert.ok(block.includes('unins000.exe'), '覆盖升级烟测没有收尾卸载');
});

test('下载脚本：官方地址与 SHA256 原样未动', () => {
  assert.ok(
    fetch.includes("$Url = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip'"),
    'fetch-vb-cable.ps1 的下载地址被改了'
  );
  assert.ok(
    fetch.includes("$ExpectedSetupHash = '734C35DFA6D98F48782A451633CEB471166EC70D60482FD89A1123D0EE3C4F41'"),
    'fetch-vb-cable.ps1 的 SHA256 被改了'
  );
});

/**
 * 覆盖安装时 WhaleLauncher.exe 被占用：CloseApplications=yes 走 Restart Manager，
 * 但启动器是 requireAdministrator、安装器是 PrivilegesRequired=lowest，RM 停不掉
 * 完整性级别更高的进程，用户就停在「DeleteFile failed; code 5 拒绝访问」上。
 * 所以安装器必须自己 taskkill（必要时提权），光靠 [Setup] 那三个开关不够。
 */
test('whale.iss：安装前主动结束正在运行的鲸鲸（提权 taskkill）', () => {
  assert.match(iss, /function PrepareToInstall\(var NeedsRestart: Boolean\): String;/, '缺 PrepareToInstall 钩子');
  assert.match(iss, /function IsAppRunning\(\): Boolean;/, '缺进程探测');
  assert.match(iss, /function KillAppProcesses\(\): Boolean;/, '缺结束进程的实现');

  // /T 必须带上：内核 node.exe 与桥接 python.exe 是子进程，还占着 runtime\ 里的文件
  assert.ok(iss.includes('taskkill /F /T /IM'), 'taskkill 没带 /T，子进程会继续占着文件');
  // 启动器提权运行，普通权限 taskkill 会失败，必须能降级到 runas
  assert.match(iss, /ShellExec\('runas', ExpandConstant\('\{cmd\}'\)/, '没有 runas 提权重试');

  // 没在运行时不能有任何提示（零 UAC、零打扰）：早退必须发生在提示之前
  const gate = iss.indexOf('if not IsAppRunning() then');
  const prompt = iss.indexOf('检测到鲸鲸正在运行');
  assert.ok(gate > 0 && prompt > gate, 'PrepareToInstall 没有先判断「没在运行」，会无端弹窗/提权');

  // 关不掉就必须中止安装，不能带着被占用的 exe 继续
  assert.ok(iss.includes("Result := '没能关闭正在运行的鲸鲸"), '关不掉时没有返回错误中止安装');
});

test('whale.iss：卸载前也先关掉鲸鲸，且静默卸载不弹框', () => {
  const un = iss.slice(iss.indexOf('procedure CurUninstallStepChanged'));
  assert.ok(un.includes('KillAppProcesses()'), '卸载流程没有结束正在运行的鲸鲸');
  assert.ok(/if WizardSilent or/.test(un), '静默卸载会弹框，第三方卸载工具会卡住');
});

test('根因是权限不匹配：启动器提权 / 安装器不提权（改了要回头重想这块）', () => {
  const manifest = read('launcher/app.manifest');
  assert.match(
    manifest,
    /requestedExecutionLevel level="requireAdministrator"/,
    '启动器不再提权运行，Restart Manager 也许就够了，重新评估这段 taskkill'
  );
  assert.match(iss, /^PrivilegesRequired=lowest$/m, '安装器不再是非提权安装，意味着 UAC 取舍变了');
});
