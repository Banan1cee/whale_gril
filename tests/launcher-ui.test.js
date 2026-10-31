'use strict';

/**
 * 启动器 UI 契约回归测试。
 *
 * 这一组不启动 WPF，也不依赖 Windows：只盯住这次重设计里容易再次踩坏的东西：
 *   1. App.xaml 里的主题画刷和 Appearance.cs 的浅色/深色表必须一一对应；
 *   2. 所有 {DynamicResource X} 都必须能在 App.xaml 找到 X，防止改名后局部不跟主题；
 *   3. 人设页不再有左侧 SubNav；设置页有分类侧栏，且「外观」固定在最后；
 *   4. 卡片不再给内容挂 DropShadowEffect（会把输入框一起投影成竖线）；
 *   5. 滚动条是自定义圆角滑块；输入框/复选框/页面关掉默认焦点虚线；
 *   6. 启动脚本和发布 exe 都在。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const launcher = path.join(root, 'launcher');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '');
const readLauncher = (rel) => fs.readFileSync(path.join(launcher, rel), 'utf8').replace(/^\uFEFF/, '');

const THEME_KEYS = [
  'Bg', 'BgDeep', 'BgNav', 'BgTop', 'CardBg', 'CardBorder', 'Line', 'LineSoft',
  'Text', 'Text2', 'Muted', 'Dim', 'Accent', 'AccentDim', 'AccentSoft',
  'Ok', 'Warn', 'Bad', 'Idle', 'PrimaryBg', 'PrimaryFg', 'PrimaryHover',
  'GhostBg', 'GhostHover', 'Hover', 'FieldBg', 'FieldBorder', 'PopupBg',
  'ChipBg', 'Surface3', 'TopBtnHover', 'ScrollThumb', 'BackdropTint',
];

const appXaml = readLauncher('App.xaml');
const appearance = readLauncher('Appearance.cs');
const resources = new Set([...appXaml.matchAll(/x:Key="([^"]+)"/g)].map((m) => m[1]));

test('App.xaml 里定义了全部主题画刷', () => {
  for (const key of THEME_KEYS) {
    assert.ok(resources.has(key), `App.xaml 缺少画刷 ${key}`);
  }
});

test('所有 {DynamicResource X} 都能在 App.xaml 找到，不会出现半明半暗', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.xaml')) files.push(full);
    }
  };
  walk(launcher);

  const missing = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    for (const match of text.matchAll(/\{DynamicResource\s+([A-Za-z0-9_]+)\}/g)) {
      if (!resources.has(match[1])) missing.push(`${path.relative(root, file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], '存在找不到的 DynamicResource 键');
});

function themeBlock(name) {
  const marker = `${name} = new Dictionary`;
  const start = appearance.indexOf(marker);
  assert.ok(start >= 0, `Appearance.cs 缺少 ${name} 主题表`);
  const end = appearance.indexOf('};', start);
  assert.ok(end > start, `${name} 主题表没有正常结束`);
  return appearance.slice(start, end);
}

function themeKeys(block) {
  return new Set([...block.matchAll(/\["([^"]+)"\]\s*=\s*"#[0-9A-Fa-f]{8}"/g)].map((m) => m[1]));
}

test('浅色/深色主题表都覆盖全部颜色键，且都是 ARGB', () => {
  const light = themeBlock('Light');
  const dark = themeBlock('Dark');
  const lightKeys = themeKeys(light);
  const darkKeys = themeKeys(dark);

  for (const key of THEME_KEYS) {
    assert.ok(lightKeys.has(key), `Light 缺少 ${key}`);
    assert.ok(darkKeys.has(key), `Dark 缺少 ${key}`);
  }
  assert.deepEqual([...lightKeys].sort(), [...darkKeys].sort(), '浅色/深色颜色键必须完全一致');
});

test('切换主题是换资源实例，配合 DynamicResource 才会全窗口刷新', () => {
  assert.match(
    appearance,
    /Application\.Current\.Resources\[kv\.Key\]\s*=\s*new SolidColorBrush\(color\)/,
    '主题切换必须替换 Application.Resources，而不是只改旧画刷'
  );
});

test('顶栏有太阳/月亮开关，背景图有独立图层和模糊', () => {
  const main = readLauncher('MainWindow.xaml');
  assert.ok(main.includes('x:Name="BtnTheme"'), '缺少主题按钮');
  assert.ok(main.includes('Click="OnToggleTheme"'), '主题按钮没接事件');
  assert.ok(main.includes('x:Name="BackdropLayer"'), '缺少背景图层');
  assert.ok(main.includes('x:Name="BackdropImage"'), '缺少背景图 Image');
  assert.ok(main.includes('<BlurEffect'), '背景图应该做模糊，避免抢文字');
});

test('人设页左侧身份/说话方式子导航已移除，分区直接铺满', () => {
  const xaml = readLauncher('Views/PersonaPage.xaml');
  const code = readLauncher('Views/PersonaPage.xaml.cs');
  assert.doesNotMatch(xaml, /\bSubNav\b/, 'PersonaPage.xaml 里还留着 SubNav');
  assert.doesNotMatch(code, /\bSubNav\b/, 'PersonaPage.xaml.cs 里还引用 SubNav');
  assert.ok(xaml.includes('x:Name="SecIdentity"'), '身份分区不该被误删');
  assert.ok(xaml.includes('x:Name="Body"'), '主体滚动区还在');
});

test('设置页有分类侧栏，外观固定在最后', () => {
  const xaml = readLauncher('Views/SettingsPage.xaml');
  const code = readLauncher('Views/SettingsPage.xaml.cs');

  assert.ok(xaml.includes('x:Name="SettingsNav"'), '缺少设置分类侧栏');
  assert.ok(xaml.includes('SettingsNavItem'), '缺少侧栏项样式');
  assert.ok(xaml.includes('SelectionChanged="OnSettingsNavChanged"'), '侧栏没接跳转事件');
  assert.match(code, /MainScroll\.ScrollToVerticalOffset/, '侧栏要能滚动到对应卡片');

  const build = code.slice(code.indexOf('private void BuildOnce()'), code.indexOf('private void AddSection'));
  const calls = [...build.matchAll(/AddSection\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(calls.length >= 4, 'BuildOnce 应该注册多个分区');
  assert.equal(calls[calls.length - 1], '外观', '外观必须排在设置的最后');
  assert.ok(calls.includes('模型与 Key'));
});

test('卡片不再把 DropShadowEffect 挂在内容上，避免竖线/糊字', () => {
  const start = appXaml.indexOf('<Style TargetType="Border" x:Key="Card">');
  assert.ok(start >= 0, '找不到 Card 样式');
  const end = appXaml.indexOf('</Style>', start);
  const card = appXaml.slice(start, end);
  assert.doesNotMatch(card, /Effect\s*=/, 'Card 不能挂 Effect，否则会投影里面的控件');
});

test('滚动条是自定义圆角滑块，页面/输入控件关掉默认焦点虚线', () => {
  assert.ok(appXaml.includes('x:Key="ScrollThumbStyle"'), '缺少滚动条滑块样式');
  assert.ok(appXaml.includes('<Track x:Name="PART_Track"'), '滚动条没有自定义 Track');
  assert.match(appXaml, /TargetType="ScrollBar"/);
  assert.match(appXaml, /TargetType="CheckBox"[\s\S]*?FocusVisualStyle" Value="\{x:Null\}"/, 'CheckBox 还留着焦点虚线');
  assert.match(appXaml, /TargetType="TextBox"[\s\S]*?FocusVisualStyle" Value="\{x:Null\}"/, 'TextBox 还留着焦点虚线');
  assert.match(readLauncher('Views/SettingsPage.xaml'), /FocusVisualStyle="\{x:Null\}"/, '设置页 FocusVisualStyle 没关');
});

test('启动脚本和新版 exe 都在仓库里', () => {
  const bat = read('启动鲸鲸界面.bat');
  assert.match(bat, /WhaleLauncher\.exe/);
  assert.match(bat, /DOTNET_ROOT/, 'bat 应该带本地运行时兜底');

  for (const rel of ['WhaleLauncher.exe', 'launcher/publish/WhaleLauncher.exe']) {
    const file = path.join(root, rel);
    assert.ok(fs.existsSync(file), `缺少 ${rel}`);
    assert.ok(fs.statSync(file).size > 100000, `${rel} 看起来不是完整 exe`);
  }
});
