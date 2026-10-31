using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Runtime.InteropServices;
using System.Windows.Interop;
using System.Windows.Threading;
using WhaleLauncher.Views;

namespace WhaleLauncher
{
    public sealed class NavEntry
    {
        public string Key { get; set; }
        public string Label { get; set; }
        public Geometry Icon { get; set; }
        public override string ToString() => Label ?? Key ?? "";
    }

    public partial class MainWindow : Window
    {
        private readonly RuntimeSupervisor _sup;
        private readonly DispatcherTimer _timer;
        private readonly Dictionary<string, UserControl> _pages = new Dictionary<string, UserControl>();
        private bool _busy;
        private bool _refreshing;
        private Snapshot _last;

        private static readonly NavEntry[] NavKeys =
        {
            new NavEntry { Key = "状态", Label = "状态", Icon = Geometry.Parse("M4 4h7v7H4z M13 4h7v4h-7z M13 10h7v10h-7z M4 13h7v7H4z") },
            new NavEntry { Key = "人设", Label = "人设", Icon = Geometry.Parse("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7") },
            new NavEntry { Key = "表情包", Label = "表情包", Icon = Geometry.Parse("M4 4h16v16H4z M8.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z M20 16l-4.6-4.6L7 20") },
            new NavEntry { Key = "主动与提醒", Label = "主动与提醒", Icon = Geometry.Parse("M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8 M10.5 20a2 2 0 0 0 3 0") },
            new NavEntry { Key = "微信桥接", Label = "微信桥接", Icon = Geometry.Parse("M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-4-.9L3 21l1.9-3.5a8.4 8.4 0 1 1 16.1-6Z M8 10h8 M8 13h5") },
            new NavEntry { Key = "诊断", Label = "诊断", Icon = Geometry.Parse("M3 12h4l2-5 4 10 2-5h6") },
            new NavEntry { Key = "设置", Label = "设置", Icon = Geometry.Parse("M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.12.4.5.86 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z") },
        };

        public MainWindow()
        {
            InitializeComponent();

            var dir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            _sup = new RuntimeSupervisor(dir);

            var ver = "v4.0.0-alpha";
            try
            {
                var vp = Path.Combine(dir, "package.json");
                if (File.Exists(vp))
                {
                    var m = Regex.Match(File.ReadAllText(vp), "\"version\"\\s*:\\s*\"([^\"]+)\"");
                    if (m.Success) ver = "v" + m.Groups[1].Value + "-alpha";
                }
            }
            catch { }
            VersionText.Text = ver;
            NavVersion.Text = ver;

            foreach (var k in NavKeys) Nav.Items.Add(k);
            Nav.SelectedIndex = 0;

            _sup.Say("启动器就绪 · " + dir);

            Appearance.Changed += OnAppearanceChanged;
            ApplyAppearance();

            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
            _timer.Tick += async (_, __) => await RefreshAsync();
            _timer.Start();

            Loaded += async (_, __) =>
            {
                Nav.SelectedIndex = 0;
                await RefreshAsync();
            };
            Closed += (_, __) =>
            {
                Appearance.Changed -= OnAppearanceChanged;
                _timer.Stop();
                _sup.Dispose();
            };
        }

        // ── 外观：主题 / 背景图 / 标题栏 ────────────────────────
        private void ApplyAppearance()
        {
            var dark = Appearance.IsDark;
            if (IconMoon != null)
            {
                IconMoon.Visibility = dark ? Visibility.Visible : Visibility.Collapsed;
                IconSun.Visibility = dark ? Visibility.Collapsed : Visibility.Visible;
            }

            var bmp = Appearance.LoadBackdrop();
            if (BackdropImage != null)
            {
                BackdropImage.Source = bmp;
                BackdropLayer.Visibility = bmp == null ? Visibility.Collapsed : Visibility.Visible;
            }

            ApplyTitleBar();
        }

        private void OnAppearanceChanged() => ApplyAppearance();

        private void OnToggleTheme(object sender, RoutedEventArgs e)
        {
            Appearance.SetTheme(Appearance.IsDark ? "light" : "dark");
        }

        private void ApplyTitleBar()
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            if (hwnd == IntPtr.Zero) return;
            int dark = Appearance.IsDark ? 1 : 0;
            // 20 = DWMWA_USE_IMMERSIVE_DARK_MODE（Win10 2004+），老系统用 19
            if (DwmSetWindowAttribute(hwnd, 20, ref dark, sizeof(int)) != 0)
                DwmSetWindowAttribute(hwnd, 19, ref dark, sizeof(int));

            // Win11：把系统标题栏也染成主题色，避免深色界面顶着一根白条
            var bg = Appearance.IsDark ? Color.FromRgb(0x0C, 0x12, 0x1A) : Color.FromRgb(0xF4, 0xF6, 0xF9);
            var fg = Appearance.IsDark ? Color.FromRgb(0xF4, 0xF7, 0xFA) : Color.FromRgb(0x12, 0x17, 0x22);
            var line = Appearance.IsDark ? Color.FromRgb(0x24, 0x31, 0x40) : Color.FromRgb(0xE5, 0xE9, 0xF0);
            int caption = ToColorRef(bg), text = ToColorRef(fg), border = ToColorRef(line);
            DwmSetWindowAttribute(hwnd, 35, ref caption, sizeof(int)); // DWMWA_CAPTION_COLOR
            DwmSetWindowAttribute(hwnd, 36, ref text, sizeof(int));    // DWMWA_TEXT_COLOR
            DwmSetWindowAttribute(hwnd, 34, ref border, sizeof(int));  // DWMWA_BORDER_COLOR
        }

        private static int ToColorRef(Color c) => c.R | (c.G << 8) | (c.B << 16);

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            var hwnd = new WindowInteropHelper(this).Handle;

            // 常态提权后，非管理员资源管理器的拖拽会被 UIPI 拦掉；放行这三条消息即可
            const uint MSGFLT_ALLOW = 1;
            ChangeWindowMessageFilterEx(hwnd, 0x0233 /* WM_DROPFILES */, MSGFLT_ALLOW, IntPtr.Zero);
            ChangeWindowMessageFilterEx(hwnd, 0x0049 /* WM_COPYGLOBALDATA */, MSGFLT_ALLOW, IntPtr.Zero);
            ChangeWindowMessageFilterEx(hwnd, 0x004A /* WM_COPYDATA */, MSGFLT_ALLOW, IntPtr.Zero);

            ApplyTitleBar();
        }

        [DllImport("dwmapi.dll", PreserveSig = true)]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool ChangeWindowMessageFilterEx(IntPtr hwnd, uint msg, uint action, IntPtr changeInfo);

        // ── 导航 ────────────────────────────────────────────────
        private void OnNavChanged(object sender, SelectionChangedEventArgs e)
        {
            var key = (Nav.SelectedItem as NavEntry)?.Key;
            if (string.IsNullOrEmpty(key)) return;

            if (!_pages.TryGetValue(key, out var page))
            {
                try
                {
                    page = CreatePage(key);
                }
                catch (Exception ex)
                {
                    _sup.Say("页面创建失败（" + key + "）：" + ex.Message);
                    page = new PlaceholderPage(key, "这一页创建失败了：" + ex.Message);
                }
                _pages[key] = page;
            }
            Host.Content = page;
            if (page is IRefreshable r) _ = r.RefreshAsync();
        }

        private UserControl CreatePage(string key)
        {
            switch (key)
            {
                case "状态": return new StatusPage(_sup);
                case "人设": return new PersonaPage(_sup);
                case "表情包": return new StickerPage(_sup);
                case "主动与提醒": return new ReminderPage(_sup);
                case "微信桥接": return new BridgePage(_sup);
                case "诊断": return new DiagPage(_sup);
                case "设置": return new SettingsPage(_sup);
                default:
                    return new PlaceholderPage(key, "这一页还没做。");
            }
        }

        private void GoTo(string key)
        {
            var item = Nav.Items.OfType<NavEntry>().FirstOrDefault(x => x.Key == key);
            if (item == null) return;
            Nav.SelectedItem = item;
            Nav.ScrollIntoView(item);
        }

        private void OnSettings(object sender, RoutedEventArgs e) => GoTo("设置");

        // ── 顶栏动作 ────────────────────────────────────────────
        private bool AnythingRunning => _sup.NodeRunning || _sup.BridgeRunning;

        private async void OnToggle(object sender, RoutedEventArgs e)
        {
            if (_busy) return;
            _busy = true;
            try
            {
                if (AnythingRunning)
                {
                    BtnToggle.IsEnabled = false;
                    _sup.Say("— 停止中 —");
                    await Task.Run(() => _sup.StopAll());
                    await Task.Delay(200);
                }
                else
                {
                    BtnToggle.IsEnabled = false;
                    _sup.Say("— 启动中 —");
                    _sup.StartNode();
                    if (await _sup.WaitForNodeAsync()) _sup.StartBridge();
                }
            }
            finally
            {
                BtnToggle.IsEnabled = true;
                _busy = false;
                await RefreshAsync();
            }
        }

        private async void OnRestart(object sender, RoutedEventArgs e)
        {
            if (_busy) return;
            _busy = true;
            try
            {
                BtnRestart.IsEnabled = false;
                _sup.Say("— 重启中 —");
                await Task.Run(() => _sup.StopAll());
                await Task.Delay(600);
                _sup.StartNode();
                if (await _sup.WaitForNodeAsync()) _sup.StartBridge();
            }
            finally
            {
                BtnRestart.IsEnabled = true;
                _busy = false;
                await RefreshAsync();
            }
        }

        private void OnOpenData(object sender, RoutedEventArgs e) => OpenDataDir();

        public void OpenDataDir()
        {
            try
            {
                Directory.CreateDirectory(_sup.DataDir);
                Process.Start(new ProcessStartInfo(_sup.DataDir) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                _sup.Say("打开数据目录失败：" + ex.Message);
            }
        }

        // ── 刷新 ────────────────────────────────────────────────
        private async Task RefreshAsync()
        {
            if (_refreshing) return;
            _refreshing = true;
            try
            {
                var s = await _sup.ProbeAsync();
                _last = s;

                DotNode.Fill = s.NodeReady ? (Brush)FindResource("Ok") : (Brush)FindResource(s.NodeUp ? "Warn" : "Idle");
                DotBridge.Fill = s.BrOnline ? (Brush)FindResource("Ok")
                    : (s.NodeUp ? (Brush)FindResource("Warn") : (Brush)FindResource("Idle"));
                DotWechat.Fill = s.BrOnline && s.BrAccountOk ? (Brush)FindResource("Ok")
                    : (s.BrOnline ? (Brush)FindResource("Warn") : (Brush)FindResource("Idle"));

                NodeStateText.Text = s.NodeUp ? "运行中" : "未启动";
                BridgeStateText.Text = s.BrOnline ? "在线" : (s.NodeUp ? "连接中" : "未启动");

                var who = string.IsNullOrEmpty(s.BrAccountNick) ? s.BrAccount : s.BrAccountNick;
                WechatStateText.Text = s.BrAccountOk ? "已登录" : (s.BrOnline ? "待确认" : "未登录");
                WechatLabel.ToolTip = string.IsNullOrEmpty(who) ? "微信" : "微信 · " + who;
                BtnToggleText.Text = AnythingRunning ? "停止" : "启动";

                var parts = new List<string>();
                if (!s.NodeUp) parts.Add("内核未启动");
                else parts.Add("内核 " + Uptime(s.UptimeSec));
                if (s.NodeUp)
                {
                    if (s.BrOnline) parts.Add(s.BrLastSeenSec >= 0 ? $"桥接 {s.BrLastSeenSec} 秒前心跳" : "桥接在线");
                    else parts.Add("桥接离线");
                }
                if (s.NodeUp && s.NeedsKey && !s.HasKey) parts.Add("还没填 Key");
                if (s.StFailed > 0) parts.Add($"发送失败 {s.StFailed}");
                parts.Add("端口 " + s.Port);
                StatusLine.Text = string.Join(" · ", parts);

                if (Host.Content is IRefreshable r) await r.RefreshAsync();
            }
            catch (Exception ex)
            {
                StatusLine.Text = "刷新状态出错：" + ex.Message;
            }
            finally { _refreshing = false; }
        }

        private static string Uptime(long sec)
        {
            if (sec <= 0) return "0 秒";
            var t = TimeSpan.FromSeconds(sec);
            if (t.TotalHours >= 1) return $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}";
            if (t.TotalMinutes >= 1) return $"{t.Minutes} 分 {t.Seconds:00} 秒";
            return $"{t.Seconds} 秒";
        }
    }
}
