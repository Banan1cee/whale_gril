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

test('更新过程有进度反馈：流式读输出 + 底栏进度条', () => {
  const svc = read('UpdateService.cs');
  assert.match(svc, /IProgress<Progress>/, 'ApplyAsync 要能把进度回传给界面');
  assert.match(svc, /BeginOutputReadLine/, '要边跑边读输出，一次性读等于没有进度');
  assert.match(svc, /Percent = pct/, '要认下载器的 "P 45 52.1/116.6" 进度行');
  assert.match(svc, /Stages/, '要有中文阶段行 → 一句话的映射');

  const xaml = read('MainWindow.xaml');
  assert.match(xaml, /x:Name="UpdateBar"/, '底栏缺进度条');
  assert.match(xaml, /<ProgressBar/, '缺 ProgressBar 控件');
  assert.match(xaml, /x:Name="UpdatePct"/, '缺百分比文字');
  assert.match(xaml, /IsIndeterminate="True"/, '没有百分比的阶段要走不确定态');
});

test('更新期间状态行不被两秒一次的刷新覆盖', () => {
  const code = read('MainWindow.xaml.cs');
  assert.match(code, /if \(!_updating\) StatusLine\.Text/, '刷新会把更新进度文字冲掉');
  assert.match(code, /ShowUpdateProgress/, '缺进度展示方法');
  assert.match(code, /HideUpdateProgress/, '更新结束要收起进度条');
});

test('更新中关窗口不会烂尾：先确认，脚本再兜底拉起', () => {
  const code = read('MainWindow.xaml.cs');
  assert.match(code, /Closing \+= OnClosingDuringUpdate/, '没挂 Closing 事件');
  assert.match(code, /OnClosingDuringUpdate/, '缺关闭确认');
  assert.match(code, /AnotherInstanceRunning/, '更新完要看脚本是不是已经把新实例拉起来了');
  assert.match(code, /Application\.Current\.Shutdown\(\)/, '已经有新实例时只关自己，别再起一个');
});
