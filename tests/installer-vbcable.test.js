'use strict';

/**
 * VB-CABLE 安装包位置契约测试。
 *
 * 起因：安装包被 [Files] 的 "..\runtime\*" 递归整棵拷进 {app}\runtime，
 * 声卡包埋在 {app}\runtime\vb-cable 里，用户装完根本找不到（CI 烟测的
 * 期望清单里也没有它，位置再错也不会红）。
 *
 * 所以这里只读文件、不调 Inno：位置一挪错，测试直接红。
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

test('whale.iss：声卡包整文件夹装到安装目录根部', () => {
  assert.ok(
    iss.includes(`DestDir: "{app}\\${FOLDER}"`),
    '没有把声卡包装到 {app}\\VB-CABLE虚拟声卡'
  );
  // 整文件夹搬：Pack45 里缺一个文件就可能装不上，不能只拷 exe
  const entryStart = iss.indexOf(`Source: "..\\runtime\\vb-cable\\*"`);
  assert.ok(entryStart > 0, '[Files] 里没有 ..\\runtime\\vb-cable\\* 这一条');
  const entry = iss.slice(entryStart, iss.indexOf('Source:', entryStart + 10));
  assert.match(entry, /recursesubdirs\s+createallsubdirs/, '声卡包没有递归整棵拷');
});

test('whale.iss：runtime 那条排除 vb-cable，包里不留两份', () => {
  const start = iss.indexOf('Source: "..\\runtime\\*"');
  assert.ok(start > 0, '[Files] 里没有 ..\\runtime\\* 这一条');
  const entry = iss.slice(start, iss.indexOf('Source:', start + 10));
  assert.ok(entry.includes('vb-cable\\*'), 'runtime 条目的 Excludes 没排掉 vb-cable\\*，声卡包装了两份');
});

test('whale.iss：指向声卡 exe 的路径都在新文件夹，旧位置只用于清理', () => {
  const lines = iss.split(/\r?\n/);
  const exeLines = lines.filter((l) => l.includes(EXE));
  assert.ok(exeLines.length > 0, 'whale.iss 里没有 VBCABLE_Setup_x64.exe');
  for (const line of exeLines) {
    assert.ok(
      line.includes(FOLDER),
      `指向声卡 exe 的路径不在 ${FOLDER} 文件夹里：${line.trim()}`
    );
    assert.ok(
      !line.includes('runtime\\vb-cable'),
      `声卡 exe 仍然指向旧的 runtime\\vb-cable：${line.trim()}`
    );
  }
  // 升级清理是唯一允许提到旧位置的地方
  assert.ok(
    iss.includes("DelTree(ExpandConstant('{app}\\runtime\\vb-cable')"),
    '升级安装没有清掉 runtime\\vb-cable 里的旧一份'
  );
});

test('启动器：先找新位置，再兜底旧安装位置', () => {
  assert.ok(page.includes(FOLDER), `VoiceSendPage.cs 没找 ${FOLDER} 文件夹`);
  assert.ok(
    page.includes(`Path.Combine(root,"${FOLDER}","${EXE}")`),
    'VoiceSendPage.cs 没有优先找新位置的 exe'
  );
  assert.ok(
    page.includes('Path.Combine(root,"runtime","vb-cable"'),
    'VoiceSendPage.cs 没保留 4.0.4 及更早安装位置的兜底'
  );
  // 两处都没有时的提示要点名准确位置，并留官网退路
  assert.ok(page.includes('安装目录\\\\' + FOLDER + '\\\\' + EXE), '找不到驱动时没告诉用户准确位置');
  assert.ok(page.includes('https://vb-audio.com/Cable/'), '找不到驱动时没给官网退路');
});

test('教程：两处提到声卡安装包时都说明在新文件夹', () => {
  assert.ok(guide.includes('包内已附 VB-CABLE 安装程序，装完就在安装目录的 ' + FOLDER), '未展开的入口说明没提新位置');
  assert.ok(guide.includes(`包内那份在安装目录的 ${FOLDER} 文件夹里`), '第 1 步的兜底说明没提新位置');
});

test('安装烟测：期望清单含新位置，且断言 runtime 里没有第二份', () => {
  const expectStart = wf.indexOf('$expect = @(');
  assert.ok(expectStart > 0, '烟测里没有 $expect 清单');
  const expectBlock = wf.slice(expectStart, wf.indexOf('$missing', expectStart));
  assert.ok(expectBlock.includes(`${FOLDER}\\${EXE}`), `烟测期望清单没有 ${FOLDER}\\${EXE}`);
  assert.ok(expectBlock.includes(`${FOLDER}\\readme.txt`), `烟测期望清单没有 ${FOLDER}\\readme.txt`);
  assert.ok(
    wf.includes("Test-Path (Join-Path $dir 'runtime\\vb-cable\\VBCABLE_Setup_x64.exe')"),
    '烟测没有反向断言 runtime\\vb-cable 里不该再有 exe'
  );
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
