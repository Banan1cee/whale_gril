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
using System.Windows.Input;
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

            var ver = "v4.0-alpha";
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
                // 静默查一次（5 秒后）：只在有新版本时亮一行字，不下载、不弹窗
                var once = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
                once.Tick += async (s, ___) =>
                {
                    once.Stop();
                    await SilentUpdateCheckAsync();
                };
                once.Start();
            };
            Closed += (_, __) =>
            {
                Appearance.Changed -= OnAppearanceChanged;
                _timer.Stop();
                _sup.Dispose();
            };
        }

        // ── 检查更新（左下角按钮 + 右上角小横幅）────────────────
        private bool _updating;
        private DispatcherTimer _toastTimer;
        private UpdateService.Result _lastUpdate;

        private void ShowToast(string text)
        {
            UpdateToastText.Text = text ?? "已检测到新版本";
            UpdateToast.Visibility = Visibility.Visible;
            if (_toastTimer == null)
            {
                _toastTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(8) };
                _toastTimer.Tick += (s, e) =>
                {
                    _toastTimer.Stop();
                    UpdateToast.Visibility = Visibility.Collapsed;
                };
            }
            _toastTimer.Stop();
            _toastTimer.Start();
        }

        private void HideToast()
        {
            _toastTimer?.Stop();
            UpdateToast.Visibility = Visibility.Collapsed;
        }

        private void OnToastClick(object sender, MouseButtonEventArgs e)
        {
            HideToast();
            if (_lastUpdate != null && _lastUpdate.HasUpdate) ConfirmUpdate(_lastUpdate);
            else OnCheckUpdate(sender, null);
            e.Handled = true;
        }

        private void SetUpdateButton(bool hasUpdate)
        {
            BtnUpdate.Content = hasUpdate ? "有新版本" : "检查更新";
        }

        private async void OnCheckUpdate(object sender, RoutedEventArgs e)
        {
            if (_updating) return;
            BtnUpdate.IsEnabled = false;
            StatusLine.Text = "正在检查更新…";
            try
            {
                var r = await UpdateService.CheckAsync(_sup.BaseDir);
                HandleUpdateResult(r, true);
            }
            finally
            {
                BtnUpdate.IsEnabled = true;
            }
        }

        /// <summary>启动后静默跑一次：只有「有新版本」才亮按钮和横幅，其余什么都不显示。</summary>
        private async Task SilentUpdateCheckAsync()
        {
            if (_updating) return;
            var r = await UpdateService.CheckAsync(_sup.BaseDir);
            if (r.Ok && r.HasUpdate) HandleUpdateResult(r, false);
        }

        private void HandleUpdateResult(UpdateService.Result r, bool interactive)
        {
            if (!r.Ok)
            {
                StatusLine.Text = "检查更新失败：" + (r.Error.Length > 0 ? r.Error : "原因不明");
                return;
            }
            if (r.HasUpdate)
            {
                _lastUpdate = r;
                SetUpdateButton(true);
                ShowToast("已检测到新版本 v" + r.Latest);
                StatusLine.Text = "发现新版本 v" + r.Latest + "（当前 v" + r.Current + "）";
                if (interactive) ConfirmUpdate(r);
                return;
            }
            _lastUpdate = null;
            SetUpdateButton(false);
            if (r.Stale) StatusLine.Text = "本地 v" + r.Current + "，远端 v" + r.Latest + "（镜像信息滞后，暂不更新）";
            else StatusLine.Text = "已是最新 v" + (r.Current.Length > 0 ? r.Current : "?");
        }

        private async void ConfirmUpdate(UpdateService.Result r)
        {
            var answer = MessageBox.Show(
                "发现新版本 v" + r.Latest + "（当前 v" + r.Current + "）。\n\n" +
                "更新会先备份，再覆盖代码；data\\ 和 config.json 不会被改动。\n" +
                "更新完会自动重启启动器（内核会先停）。\n\n现在更新吗？",
                "检查更新", MessageBoxButton.YesNo, MessageBoxImage.Question);
            if (answer != MessageBoxResult.Yes) return;

            _updating = true;
            BtnUpdate.IsEnabled = false;
            StatusLine.Text = "正在更新，别关窗口…";
            try
            {
                var err = await UpdateService.ApplyAsync(_sup.BaseDir);
                if (err.Length > 0)
                {
                    StatusLine.Text = "更新失败：" + err;
                    MessageBox.Show("更新失败：" + err + "\n\n再点一次「检查更新」可以重试（失败会自动回滚）。",
                        "检查更新", MessageBoxButton.OK, MessageBoxImage.Warning);
                    return;
                }

                // 更新完必须重启：跑着的还是旧镜像，旧 exe 也只有等本进程退出才删得掉。
                // 重启交给 --replace：新实例等本进程退出 → 抢单实例锁 → 顺手清 *.old-*。
                SetUpdateButton(false);
                StatusLine.Text = "已更新到 v" + r.Latest + "，正在重启…";
                await Task.Delay(900);
                if (!RestartSelf(out var restartErr))
                {
                    StatusLine.Text = "已更新到 v" + r.Latest + "，请手动重新打开";
                    MessageBox.Show(
                        "更新完成，但自动重启失败：" + restartErr + "\n\n请手动关掉再打开启动器（新版要重启才生效）。",
                        "检查更新", MessageBoxButton.OK, MessageBoxImage.Information);
                }
            }
            finally
            {
                _updating = false;
                BtnUpdate.IsEnabled = true;
            }
        }

        /// <summary>
        /// 重启自己：起一个新实例（带 --replace 本进程 PID），然后关掉本进程。
        /// 返回 false 表示起不来，调用方负责提示。
        /// </summary>
        private bool RestartSelf(out string error)
        {
            error = "";
            try
            {
                // 不写死文件名：更新可能刚把 exe 换掉（甚至以后会改名），
                // ProcessPath 永远是"我是从哪个路径启动的"，正好就是要重启的那个。
                var exe = Environment.ProcessPath;
                if (string.IsNullOrEmpty(exe)) exe = Path.Combine(AppContext.BaseDirectory, "WhaleLauncher.exe");
                Process.Start(new ProcessStartInfo(exe)
                {
                    UseShellExecute = true,
                    WorkingDirectory = AppContext.BaseDirectory,
                    // 让新进程等本进程退出再抢单实例锁，否则会弹「已经在运行」
                    Arguments = "--replace " + Environment.ProcessId,
                });
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
            Application.Current.Shutdown();
            return true;
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

                NodeStateText.Text = s.NodeUp ? "端口 " + s.Port : "内核未启动";
                BridgeStateText.Text = s.BrOnline ? "在线" : (s.NodeUp ? "连接中" : "未启动");

                var who = string.IsNullOrEmpty(s.BrAccountNick) ? s.BrAccount : s.BrAccountNick;
                WechatStateText.Text = s.BrAccountOk ? "已登录" : (s.BrOnline ? "待确认" : "未登录");
                WechatLabel.ToolTip = string.IsNullOrEmpty(who) ? "微信" : "微信 · " + who;
                BtnToggleText.Text = AnythingRunning ? "停止" : "启动";

                // 内核与端口已经并进顶栏的内核胶囊；这里只说桥接和需要处理的状态
                var parts = new List<string>();
                if (s.NodeUp)
                {
                    if (s.BrOnline) parts.Add(s.BrLastSeenSec >= 0 ? $"桥接 {s.BrLastSeenSec} 秒前心跳" : "桥接在线");
                    else parts.Add("桥接离线");
                }
                if (s.NodeUp && s.NeedsKey && !s.HasKey) parts.Add("还没填 Key");
                if (s.StFailed > 0) parts.Add($"发送失败 {s.StFailed}");
                StatusLine.Text = parts.Count > 0 ? string.Join(" · ", parts) : "启动器就绪";

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
