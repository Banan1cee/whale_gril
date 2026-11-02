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

test('保存模型后重新拉设置，看图页不会停在旧模型', () => {
  const code = read('Views/SettingsPage.xaml.cs');
  // 服务端保存时会顺带改看图模型（跟随/解除跟随）；不刷新的话界面还是旧值
  const saveBlock = code.slice(code.indexOf('save.Click += async'), code.indexOf('test.Click += async'));
  assert.match(saveBlock, /_lastLoad = DateTime\.MinValue/, '保存成功要绕过节流强制重读');
  assert.match(saveBlock, /await LoadConfigAsync\(\)/, '保存成功要重新回填表单');
  // 看图页自己的「保存」也必须回填：它现在连模型一起存，不回填就还是旧模型
  const saveVision = code.slice(code.indexOf('async Task<bool> SaveVisionAsync'), code.indexOf('vsave.Click += async'));
  assert.match(saveVision, /await LoadConfigAsync\(\)/, '保存看图设置后要刷新状态');
});

test('看图是「服务商 + 模型」两个下拉；自动跟随时只留「测一下」', () => {
  const code = read('Views/SettingsPage.xaml.cs');
  // 服务商下拉第一项固定是「自动跟随聊天模型」
  assert.match(code, /new ProviderItem \{ Key = "", Label = "自动跟随聊天模型" \}/, '看图服务商要有「自动跟随」这一项');
  assert.match(code, /var visionProvider = new ComboBox/, '看图页要有服务商下拉');
  // 模型下拉不可编辑，选项跟聊天模型同一份（models + visionModels）
  assert.doesNotMatch(code, /var visionModel = new ComboBox \{[^}]*IsEditable = true/, '看图模型不要再做成编辑框');
  const fill = code.slice(code.indexOf('void FillVisionModels'), code.indexOf('bool VisionIsAuto'));
  assert.match(fill, /pv\.TryGetProperty\("models"/, '模型下拉要跟聊天模型一样的选项');
  assert.match(fill, /pv\.TryGetProperty\("visionModels"/, '同时要把这家的看图模型补进去');
  // 自动模式隐藏其余控件，只留「测一下」
  const mode = code.slice(code.indexOf('void ApplyVisionMode'), code.indexOf('// 保存这一页的全部内容'));
  assert.match(mode, /visionModelRow\.Visibility = auto \? Visibility\.Collapsed/, '自动时隐藏模型下拉');
  assert.match(mode, /visionKeyRow\.Visibility = auto \? Visibility\.Collapsed/, '自动时隐藏看图 Key');
  assert.match(mode, /vsave\.Visibility = auto \? Visibility\.Collapsed/, '自动时隐藏「保存看图设置」');
  assert.doesNotMatch(mode, /vtest\.Visibility/, '「测一下」任何模式下都不能隐藏');
  // 保存时把服务商一起提交
  const saveVision = code.slice(code.indexOf('async Task<bool> SaveVisionAsync'), code.indexOf('vsave.Click += async'));
  assert.match(saveVision, /visionProvider/, '保存看图设置要带上服务商，不能只存模型');
  assert.match(saveVision, /VisionValue\(\)/, '保存要带上模型');
});

test('自动跟随的看图 Key 取聊天那把（provider 只在 config.json 也不误报没 Key）', () => {
  const code = fs.readFileSync(path.join(root, 'src', 'adapters', 'vision.js'), 'utf8');
  assert.match(code, /if \(vc\.auto\)[\s\S]{0,200}resolveRuntime\(config\)\.apiKey/, '自动模式要用聊天运行时的 Key');
});

test('「自动跟随」只在聊天模型能识图时出现，否则不让人选', () => {
  const code = read('Views/SettingsPage.xaml.cs');
  assert.match(code, /bool ChatCanSeeImages\(\)/, '要先判断聊天模型能不能识图');
  assert.match(code, /currentPreset\.TryGetProperty\("visionModels"/, '按当前服务商的能看图清单判断');
  const rebuild = code.slice(code.indexOf('void RebuildVisionProviders'), code.indexOf('void EnsureVisionSelection'));
  assert.match(rebuild, /if \(ChatCanSeeImages\(\)\)[\s\S]{0,160}自动跟随聊天模型/, '不能识图时不能把「自动跟随」加进下拉');
  assert.match(rebuild, /ProviderHasVision\(kv\.Key\)/, '只列真的有看图模型的服务商');
  // 聊天模型切成不能识图的：自动项消失 → 落到手动并立刻保存
  assert.match(code, /if \(wasAuto && !VisionIsAuto\(\)\) await AutoSaveVisionAsync\(\)/, '自动失效时要落成手动保存');
  assert.match(code, /if \(wasAuto && !VisionIsAuto\(\)\) EnsureVisionSelection\(\)/, '自动失效时要补选一个手动服务商');
});

test('微信桥接页的编码是中文选项，且提示了 4.1/4.2 该选哪个', () => {
  const xaml = read('Views/BridgePage.xaml');
  assert.match(xaml, /x:Name="CmbCharMode"/, '桥接页要有编码选择');
  assert.match(xaml, /x:Name="CharModeHint"/, '缺一句「乱码时改这里」的说明');
  const code = read('Views/BridgePage.xaml.cs');
  assert.match(code, /UTF-16（微信 4\.2 及以上）/, '选项要写清楚对应哪个微信版本');
  assert.match(code, /GBK（微信 4\.1 及以前）/, '4.1.x 用户要能一眼找到 GBK');
  assert.match(code, /private static readonly string\[\] CharModeValues/, '界面文案和存盘值要分开，存盘仍是 auto/utf16/gbk');
});

test('测试失败的提示不依赖内核版本：内核只回 probe 时也要显示人话', () => {
  const api = read('Api.cs');
  assert.match(api, /TryGetProperty\("probe", out var probe\)/, '要从 probe 里兜底取 message');
  assert.match(api, /pm\.GetString\(\)/, '取到的 message 要变成 Error');
  assert.match(api, /原始错误：/, '原始错误要附上，方便判断是余额还是 Key');
});

test('模型页所有输入都自动保存（失焦/换选项/勾选），手动保存按钮仍然在', () => {
  const code = read('Views/SettingsPage.xaml.cs');
  assert.match(code, /async Task AutoSaveChatAsync\(\)/, '缺聊天设置的自动保存');
  assert.match(code, /async Task AutoSaveVisionAsync\(\)/, '缺看图设置的自动保存');
  assert.match(code, /key\.LostFocus \+= async \(s, e\) => \{ if \(key\.Password\.Length > 0\) await AutoSaveChatAsync\(\); \}/, 'API Key 填完失焦要自动保存');
  assert.match(code, /baseUrl\.LostFocus/, '接口地址失焦要自动保存');
  assert.match(code, /model\.LostFocus/, '模型名失焦要自动保存');
  assert.match(code, /mock\.Click \+= async/, '演示模式勾选要自动保存');
  assert.match(code, /visionKey\.LostFocus/, '看图 Key 失焦要自动保存');
  assert.match(code, /await AutoSaveChatAsync\(\);[\s\S]{0,400}model\.SelectionChanged/, '换模型服务商后要自动保存');
  // 手动按钮必须保留（用户原话：手动保存已经存在的不用管）
  assert.match(code, /Content = "保存"/, '手动保存按钮不能被删掉');
  assert.match(code, /Content = "保存看图设置"/, '看图的手动保存按钮也不能删');
});

test('提醒页的输入也自动保存，手动按钮保留', () => {
  const code = read('Views/ReminderPage.xaml.cs');
  assert.match(code, /TxtMaxPerDay\.LostFocus \+= async/, '每天次数失焦要保存');
  assert.match(code, /TxtQuiet\.LostFocus \+= async/, '跳过时长失焦要保存');
  assert.match(code, /ChkEnabled\.Click \+= async/, '开关要保存');
  assert.match(code, /TxtCareEvery\.LostFocus|\{ TxtCareEvery, TxtCareJitter/, '主动搭话的输入要保存');
  assert.match(code, /async Task<bool> SaveCareAsync\(\)/, '主动搭话要抽出可复用的保存');
  assert.match(code, /async Task<bool> SaveRulesAsync\(\)/, '提醒规则要抽出可复用的保存');
});
