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

test('设置页去掉侧栏和标题，单列铺开，模型/高级模式/外观', () => {
  const xaml = readLauncher('Views/SettingsPage.xaml');
  const code = readLauncher('Views/SettingsPage.xaml.cs');

  assert.ok(!xaml.includes('SettingsNav'), '设置页不该再有分类侧栏');
  assert.ok(!xaml.includes('SelectionChanged="OnSettingsNavChanged"'), '侧栏跳转事件应删掉');
  assert.ok(!xaml.includes('Text="设置"'), '设置页顶部的「设置」标题应去掉');
  assert.ok(xaml.includes('x:Name="SectionsHost"'), '缺少单列卡片容器');
  assert.ok(xaml.includes('x:Name="MainScroll"'), '缺少滚动区');
  assert.ok(xaml.includes('x:Name="KernelHint"'), '内核提示行不该丢');
  assert.ok(xaml.includes('x:Name="StatusText"'), '保存状态行不该丢');

  // 顺序：模型 → 高级模式 → 外观；外观必须最后
  const build = code.slice(code.indexOf('private void BuildOnce()'), code.indexOf('private void AddSection'));
  const order = ['BuildModelSection()', 'BuildAdvancedSection()', 'BuildAppearanceSection()']
    .map((x) => build.indexOf(x));
  assert.ok(order.every((i) => i >= 0), 'BuildOnce 应该显式建 模型/高级模式/外观 三张卡');
  assert.ok(order[0] < order[1] && order[1] < order[2], '顺序必须是 模型 → 高级模式 → 外观');

  // 模型卡三个页签：聊天 / 看图 / 语音
  const modelSection = code.slice(code.indexOf('private Border BuildModelSection()'), code.indexOf('// ── 读写'));
  for (const tab of ['聊天（文本）', '看图（视觉）', '语音']) {
    assert.ok(modelSection.includes(tab), '模型卡缺少页签：' + tab);
  }
  assert.ok(modelSection.includes('语音（识别）') && modelSection.includes('voice.model'), '识别参数应留在模型卡');
  assert.ok(!modelSection.includes('Label = "语音回复"'), '识别页不应显示语音回复开关');

  // 高级模式：一张卡默认收起，含四组
  const advSection = code.slice(code.indexOf('private Border BuildAdvancedSection()'), code.indexOf('private Border BuildAppearanceSection()'));
  assert.match(advSection, /Visibility = Visibility\.Collapsed/, '高级模式默认要收起');
  assert.ok(advSection.includes('MakeTab'), '高级模式要用和模型卡一样的胶囊页签');
  assert.ok(advSection.includes('MarkTab'), '页签选中态要复用同一套样式');
  for (const t of ['群聊', '微信 · 数据与管道', '联网与链接', '高级']) {
    assert.ok(advSection.includes(t) || code.includes('Title = "' + t + '"'), '高级模式缺少分组：' + t);
  }

  // 语音不再单独占一个 Specs 分区
  const specs = code.slice(code.indexOf('private static List<SectionSpec> Specs()'), code.indexOf('private void BuildOnce'));
  const titles = [...specs.matchAll(/Title = "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(titles.length >= 4, `Specs 里应该有多个分组，实际 ${titles.length} 个`);
  assert.ok(!titles.includes('语音'), '语音已并进模型卡，不该再占 Specs 分组');
});

test('「深度思考」开关在模型卡的聊天页里，默认关，读写 settings.thinking', () => {
  const code = readLauncher('Views/SettingsPage.xaml.cs');
  const chatStart = code.indexOf('// ── 聊天面板');
  const voiceStart = code.indexOf('// ── 语音面板');
  assert.ok(chatStart >= 0 && voiceStart > chatStart, '找不到聊天 / 语音面板分界');
  const chatPanel = code.slice(chatStart, voiceStart);
  assert.ok(chatPanel.includes('"深度思考"'), '聊天页缺少深度思考开关');
  assert.ok(chatPanel.includes('思考 token 计入输出预算'), '要说明变慢 / 变贵');
  // 不能再挂 config 的 deepseek.thinking：它会被网页保存的 settings.thinking 盖掉
  assert.ok(!code.includes('Path = "deepseek.thinking"'), '不要再用 config 的 deepseek.thinking');
  assert.ok(!code.includes('思考（打开后会减慢说话速度）'), '旧语音页开关要删掉');
  // 读写都走 data/settings.json：保存时带 thinking，加载时回填
  assert.ok(code.includes('\\"thinking\\":'), '保存请求要带 thinking');
  assert.ok(code.includes('TryGetProperty("thinking"'), '加载时要回填 thinking');
  // 默认必须是关：DEFAULT_CONFIG 里 thinking=false
  const config = read('src/infra/config.js');
  assert.match(config, /thinking: false/, '默认值应为 false');
});
test('诊断页内置 UIA 自检与数据维护，不用再开 bat', () => {
  const xaml = readLauncher('Views/DiagPage.xaml');
  const code = readLauncher('Views/DiagPage.xaml.cs');
  for (const t of ['UIA 自检', '备份记忆', '恢复记忆', '重置全部']) {
    assert.ok(xaml.includes(t), '诊断页缺少按钮：' + t);
  }
  assert.ok(code.includes('memory-tool.js'), '备份/恢复应该走 memory-tool.js');
  assert.ok(code.includes('factory-reset.ps1'), '重置全部应该走 factory-reset.ps1');
  assert.match(code, /_sup\.StopAll\(\)/, '恢复记忆前必须先停内核');
  assert.ok(xaml.includes('uia-check.py') || code.includes('uia-check.py'), 'UIA 自检入口');
  assert.equal((code.match(/AskInline\(/g) || []).length >= 2, true, '重置全部必须两次应用内确认');
  // 命令行工具要给启动器吐 JSON 列表
  const tool = readLauncher('../scripts/memory-tool.js');
  assert.match(tool, /--json/, 'memory-tool list 要支持 --json');
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

test('新版 exe 都在仓库里', () => {
  for (const rel of ['WhaleLauncher.exe', 'launcher/publish/WhaleLauncher.exe']) {
    const file = path.join(root, rel);
    assert.ok(fs.existsSync(file), `缺少 ${rel}`);
    assert.ok(fs.statSync(file).size > 100000, `${rel} 看起来不是完整 exe`);
  }
});

test('图标接好了：csproj 的 exe 图标 + 窗口图标 + 安装包图标', () => {
  const csproj = readLauncher('WhaleLauncher.csproj');
  assert.match(csproj, /<ApplicationIcon>Assets\\app\.ico<\/ApplicationIcon>/, 'csproj 没有 ApplicationIcon');
  assert.match(csproj, /<Resource Include="Assets\\app\.ico"\s*\/>/, 'app.ico 没当 WPF 资源，窗口 Icon 会找不到');

  const win = readLauncher('MainWindow.xaml').slice(0, 800);
  assert.match(win, /Icon="Assets\/app\.ico"/, 'MainWindow 没挂窗口图标');

  const ico = path.join(launcher, 'Assets', 'app.ico');
  assert.ok(fs.existsSync(ico), '缺少 launcher/Assets/app.ico');
  const head = fs.readFileSync(ico).subarray(0, 4);
  assert.deepEqual([...head], [0x00, 0x00, 0x01, 0x00], 'app.ico 不是 ICO 文件');
  assert.ok(fs.statSync(ico).size > 20000, 'app.ico 太小，多半只有单尺寸');

  const iss = read('installer/whale.iss');
  assert.match(iss, /SetupIconFile=\{#SrcDir\}\\launcher\\Assets\\app\.ico/, '安装包没有 SetupIconFile');
});
