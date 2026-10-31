using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
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
    public partial class MainWindow : Window
    {
        private readonly RuntimeSupervisor _sup;
        private readonly DispatcherTimer _timer;
        private readonly Dictionary<string, UserControl> _pages = new Dictionary<string, UserControl>();
        private bool _busy;
        private Snapshot _last;

        private static readonly string[] NavKeys =
        {
            "状态", "人设", "表情包", "主动与提醒", "微信桥接", "诊断", "设置"
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
            FootVersion.Text = ver;

            foreach (var k in NavKeys) Nav.Items.Add(k);

            _sup.Say("启动器就绪 · " + dir);

            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
            _timer.Tick += async (_, __) => await RefreshAsync();
            _timer.Start();

            Loaded += async (_, __) =>
            {
                Nav.SelectedIndex = 0;
                await RefreshAsync();
            };
            Closed += (_, __) => _sup.Dispose();
        }

        // ── 窗口外观与拖拽放行 ──────────────────────────────────
        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            var hwnd = new WindowInteropHelper(this).Handle;
            int dark = 1;
            // 20 = DWMWA_USE_IMMERSIVE_DARK_MODE（Win10 2004+），老系统用 19
            if (DwmSetWindowAttribute(hwnd, 20, ref dark, sizeof(int)) != 0)
                DwmSetWindowAttribute(hwnd, 19, ref dark, sizeof(int));

            // 常态提权后，非管理员资源管理器的拖拽会被 UIPI 拦掉；放行这三条消息即可
            const uint MSGFLT_ALLOW = 1;
            ChangeWindowMessageFilterEx(hwnd, 0x0233 /* WM_DROPFILES */, MSGFLT_ALLOW, IntPtr.Zero);
            ChangeWindowMessageFilterEx(hwnd, 0x0049 /* WM_COPYGLOBALDATA */, MSGFLT_ALLOW, IntPtr.Zero);
            ChangeWindowMessageFilterEx(hwnd, 0x004A /* WM_COPYDATA */, MSGFLT_ALLOW, IntPtr.Zero);
        }

        [DllImport("dwmapi.dll", PreserveSig = true)]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool ChangeWindowMessageFilterEx(IntPtr hwnd, uint msg, uint action, IntPtr changeInfo);

        // ── 导航 ────────────────────────────────────────────────
        private void OnNavChanged(object sender, SelectionChangedEventArgs e)
        {
            var key = Nav.SelectedItem as string;
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
            Nav.SelectedItem = key;
            Nav.ScrollIntoView(key);
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
                    _sup.StopAll();
                    await Task.Delay(200);
                }
                else
                {
                    BtnToggle.IsEnabled = false;
                    _sup.Say("— 启动中 —");
                    _sup.StartNode();
                    await Task.Delay(1200);   // 等内核监听端口，再拉桥接
                    _sup.StartBridge();
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
                _sup.StopAll();
                await Task.Delay(600);
                _sup.StartNode();
                await Task.Delay(1200);
                _sup.StartBridge();
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
            try
            {
                var s = await _sup.ProbeAsync();
                _last = s;

                DotNode.Fill = s.NodeUp ? (Brush)FindResource("Ok") : (Brush)FindResource("Idle");
                DotBridge.Fill = s.BrOnline ? (Brush)FindResource("Ok")
                    : (s.NodeUp ? (Brush)FindResource("Warn") : (Brush)FindResource("Idle"));
                DotWechat.Fill = s.BrOnline && s.BrAccountOk ? (Brush)FindResource("Ok")
                    : (s.BrOnline ? (Brush)FindResource("Warn") : (Brush)FindResource("Idle"));

                var who = string.IsNullOrEmpty(s.BrAccountNick) ? s.BrAccount : s.BrAccountNick;
                WechatLabel.Text = string.IsNullOrEmpty(who) ? "微信" : "微信 · " + who;
                BtnToggle.Content = AnythingRunning ? "⏻ 停止" : "⏻ 启动";

                var parts = new List<string>();
                if (!s.NodeUp) parts.Add("内核未启动");
                else parts.Add("内核 " + Uptime(s.UptimeSec));
                if (s.NodeUp)
                {
                    if (s.BrOnline) parts.Add(s.BrLastSeenSec >= 0 ? $"桥接 {s.BrLastSeenSec} 秒前心跳" : "桥接在线");
                    else parts.Add("桥接离线");
                }
                if (s.NodeUp && !s.HasKey) parts.Add("还没填 Key");
                if (s.StFailed > 0) parts.Add($"发送失败 {s.StFailed}");
                parts.Add("端口 " + s.Port);
                StatusLine.Text = string.Join(" · ", parts);

                if (Host.Content is IRefreshable r) await r.RefreshAsync();
            }
            catch (Exception ex)
            {
                StatusLine.Text = "刷新状态出错：" + ex.Message;
            }
        }

        private static string Uptime(long sec)
        {
            if (sec <= 0) return "0 秒";
            var t = TimeSpan.FromSeconds(sec);
            if (t.TotalHours >= 1) return $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}";
            if (t.TotalMinutes >= 1) return $"{t.Minutes} 分 {t.Seconds} 秒";
            return $"{t.Seconds} 秒";
        }
    }
}
