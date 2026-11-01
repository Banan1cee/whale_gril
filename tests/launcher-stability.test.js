'use strict';

/**
 * 启动器两个「用起来像坏了」的问题，守住不再回潮：
 *   1. 可编辑下拉（模型名）必须有 PART_EditableTextBox，否则 IsEditable=true 时文字根本不渲染；
 *   2. 检查更新不能在 UI 线程上同步等子进程，否则点一下冻几秒。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, 'launcher', rel), 'utf8').replace(/^\uFEFF/, '');

test('ComboBox 模板带可编辑输入框，IsEditable 时才显示', () => {
  const xaml = read('App.xaml');
  assert.match(xaml, /x:Name="PART_EditableTextBox"/, '缺 PART_EditableTextBox，可编辑下拉会显示空白');
  assert.match(xaml, /<Trigger Property="IsEditable" Value="True">/, '缺 IsEditable 触发器');
  assert.match(xaml, /TargetName="PART_EditableTextBox" Property="Visibility" Value="Visible"/);
  assert.match(xaml, /TargetName="ContentSite" Property="Visibility" Value="Collapsed"/);
  // 模板里必须有 ContentSite 这个名字，否则触发器找不到目标
  assert.match(xaml, /x:Name="ContentSite"/);
});

test('模型名下拉仍然是可编辑的（没有型号时可以手输）', () => {
  const code = read('Views/SettingsPage.xaml.cs');
  assert.match(code, /var model = new ComboBox \{[^}]*IsEditable = true/, '模型名下拉丢了 IsEditable');
});

test('检查更新不在 UI 线程同步等进程', () => {
  const code = read('UpdateService.cs');
  assert.doesNotMatch(code, /\.WaitForExit\(30000\)/, '同步 WaitForExit 会卡住 UI 线程');
  assert.match(code, /WaitForExitAsync/, '应该用 WaitForExitAsync');
  assert.match(code, /CancellationTokenSource\(TimeSpan\.FromSeconds\(30\)\)/, '保留 30 秒超时');
  assert.match(code, /OperationCanceledException/, '超时要被接住并 Kill');
});
