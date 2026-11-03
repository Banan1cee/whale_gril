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

            // 正式版不该显示成 v4.0-alpha：那会让用户以为自己装的是测试版，
            // 而且强制更新拿这个版本号做比较，后缀只会添乱。
            var ver = UpdateManifestService.LocalVersion(dir);
            VersionText.Text = ver.Length > 0 ? "v" + ver : "v?";

            foreach (var k in NavKeys) Nav.Items.Add(k);
            Nav.Items.Insert(3, new NavEntry { Key = "语音发送", Label = "语音发送", Icon = Geometry.Parse("M9 3h6v12H9z M5 10v3a7 7 0 0 0 14 0v-3 M12 20v3 M8 23h8") });
            Nav.SelectedIndex = 0;

            _sup.Say("启动器就绪 · " + dir);

            Appearance.Changed += OnAppearanceChanged;
            ApplyAppearance();

            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
            _timer.Tick += async (_, __) =>
            {
                await RefreshAsync();
                await MaybePeriodicUpdateCheckAsync();
            };
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
            Closing += OnClosingDuringUpdate;
            Closed += (_, __) =>
            {
                Appearance.Changed -= OnAppearanceChanged;
                _timer.Stop();
                _sup.Dispose();
            };
        }

        // ── 检查更新（左下角按钮 + 右上角小横幅）────────────────
        private bool _updating;
        private bool _forceDialogOpen;
        private DispatcherTimer _toastTimer;
        private ManifestCheck _lastManifest;
        private DateTime _lastManifestCheck = DateTime.MinValue;

        // 挂后台不关的用户也要能看到新版：每 6 小时静默查一次（只提示，不拦人）。
        private const int PeriodicCheckHours = 6;

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
            if (_lastManifest != null && _lastManifest.HasUpdate) _ = RunUpdateAsync(_lastManifest, askFirst: true);
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
                var chk = await UpdateManifestService.FetchAsync(_sup.BaseDir);
                ApplyManifestPolicy(chk, true);
            }
            finally
            {
                BtnUpdate.IsEnabled = true;
            }
        }

        /// <summary>
        /// 拿清单结果决定界面形态。这里只做「提示 / 强制 / 禁止启动」的判定，
        /// 不下载；真下载仍交给 scripts/update.ps1（带备份和失败回滚）。
        /// </summary>
        private async Task SilentUpdateCheckAsync()
        {
            if (_updating) return;
            _lastManifestCheck = DateTime.Now;
            var chk = await UpdateManifestService.FetchAsync(_sup.BaseDir);
            ApplyManifestPolicy(chk, false);
        }

        /// <summary>
        /// 挂后台一直不关的用户，也需要知道有新版。
        /// 运行中只更新提示和按钮，不弹强制窗——人正在用，突然盖遮罩太粗暴；
        /// 强制 / 熔断仍然只在「启动」那一刻判定，下次重启才真的拦。
        /// </summary>
        private async Task MaybePeriodicUpdateCheckAsync()
        {
            if (_updating) return;
            if ((DateTime.Now - _lastManifestCheck).TotalHours < PeriodicCheckHours) return;
            _lastManifestCheck = DateTime.Now;
            var chk = await UpdateManifestService.FetchAsync(_sup.BaseDir);
            ApplyManifestPolicy(chk, interactive: false, allowBlocking: false);
        }

        private void ApplyManifestPolicy(ManifestCheck chk, bool interactive, bool allowBlocking = true)
        {
            switch (chk.Policy)
            {
                case UpdatePolicy.Kill:
                    if (!allowBlocking)
                    {
                        // 定时检查不拦人：只在状态行说明，下次启动才真的停用
                        _lastManifest = null;
                        SetUpdateButton(false);
                        StatusLine.Text = "当前版本已被停用，下次启动需要更新";
                        return;
                    }
                    _lastManifest = null;
                    SetUpdateButton(false);
                    ShowKilled(chk);
                    return;

                case UpdatePolicy.Force:
                    if (!allowBlocking)
                    {
                        // 运行中不打断，退化成提示
                        _lastManifest = chk;
                        SetUpdateButton(true);
                        ShowToast("必须更新到 v" + chk.Manifest.Latest);
                        StatusLine.Text = "当前版本需要更新到 v" + chk.Manifest.Latest + "（下次启动生效）";
                        return;
                    }
                    _lastManifest = chk;
                    SetUpdateButton(true);
                    ShowToast("必须更新到 v" + chk.Manifest.Latest);
                    StatusLine.Text = "当前 v" + chk.Current + " 已停止支持，需要更新到 v" + chk.Manifest.Latest;
                    _ = RunUpdateAsync(chk, askFirst: false);   // 强制态不给「以后再说」
                    return;

                case UpdatePolicy.Warn:
                    _lastManifest = chk;
                    SetUpdateButton(true);
                    ShowToast("已检测到新版本 v" + chk.Manifest.Latest);
                    StatusLine.Text = chk.FromCache
                        ? "发现新版本 v" + chk.Manifest.Latest + "（" + chk.Error + "）"
                        : "发现新版本 v" + chk.Manifest.Latest + "（当前 v" + chk.Current + "）";
                    if (interactive) _ = RunUpdateAsync(chk, askFirst: true);
                    return;

                default:
                    _lastManifest = null;
                    SetUpdateButton(false);
                    StatusLine.Text = chk.Error.Length > 0
                        ? "检查更新失败：" + chk.Error + "（不影响使用）"
                        : "已是最新 v" + (chk.Current.Length > 0 ? chk.Current : "?");
                    return;
            }
        }

        /// <summary>被熔断：说明原因后退出，不创建主界面。宁可停掉，也别让人用会写坏数据的版本。</summary>
        private void ShowKilled(ManifestCheck chk)
        {
            var msg = "当前版本 v" + chk.Current + " 已被停用。\n\n"
                + (chk.Manifest != null && chk.Manifest.Message.Length > 0
                    ? chk.Manifest.Message
                    : "这个版本存在已知的严重问题，请下载最新版。")
                + "\n\n请到 GitHub Releases 下载最新安装包。";
            MessageBox.Show(msg, "版本已停用", MessageBoxButton.OK, MessageBoxImage.Stop);
            Application.Current.Shutdown();
        }

        /// <summary>强制态用独立小窗，只给「立即更新」和「退出」，没有「以后再说」。</summary>
        private void ShowForceDialog(ManifestCheck chk)
        {
            if (_forceDialogOpen) return;
            _forceDialogOpen = true;
            try
            {
                var win = new Window
                {
                    Title = "需要更新",
                    Width = 470,
                    SizeToContent = SizeToContent.Height,
                    WindowStartupLocation = WindowStartupLocation.CenterOwner,
                    ResizeMode = ResizeMode.NoResize,
                    WindowStyle = WindowStyle.ToolWindow,
                    Owner = this,
                    Topmost = true,
                };
                var panel = new StackPanel { Margin = new Thickness(24) };
                panel.Children.Add(new TextBlock
                {
                    Text = "需要更新后才能继续使用",
                    FontSize = 18,
                    FontWeight = FontWeights.SemiBold,
                });
                panel.Children.Add(new TextBlock
                {
                    Text = "当前 v" + chk.Current + "，最新 v" + chk.Manifest.Latest + "。\n\n"
                        + (chk.Manifest.Message.Length > 0 ? chk.Manifest.Message : "这个版本已经停止支持。"),
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(0, 14, 0, 0),
                });
                var row = new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Margin = new Thickness(0, 22, 0, 0),
                };
                var quit = new Button
                {
                    Content = "退出",
                    MinWidth = 88,
                    Margin = new Thickness(0, 0, 8, 0),
                    Style = (Style)FindResource("Ghost"),
                };
                quit.Click += (_, __) => Application.Current.Shutdown();
                var now = new Button
                {
                    Content = "立即更新",
                    MinWidth = 112,
                    Style = (Style)FindResource("Primary"),
                };
                now.Click += (_, __) =>
                {
                    win.Close();
                    _ = RunUpdateAsync(chk, askFirst: false);
                };
                row.Children.Add(quit);
                row.Children.Add(now);
                panel.Children.Add(row);
                win.Content = panel;
                win.ShowDialog();
            }
            finally
            {
                _forceDialogOpen = false;
            }
        }

        /// <summary>
        /// 真正下载并换版：跑 update.ps1 -Yes -Force（脚本自己备份、覆盖、自检、失败回滚）。
        /// askFirst=false 用于强制态：不再问「现在更新吗」，只留「立即更新 / 退出」。
        /// </summary>
        private async Task RunUpdateAsync(ManifestCheck chk, bool askFirst)
        {
            if (_updating || chk == null || chk.Manifest == null) return;
            var latest = chk.Manifest.Latest;

            if (askFirst)
            {
                var answer = MessageBox.Show(
                    "发现新版本 v" + latest + "（当前 v" + chk.Current + "）。\n\n"
                    + (chk.Manifest.Message.Length > 0 ? chk.Manifest.Message + "\n\n" : "")
                    + "更新会先备份，再覆盖代码；data\\ 和 config.json 不会被改动。\n"
                    + "更新完会自动重启启动器（内核会先停）。更新期间关掉窗口也不要紧——"
                    + "脚本会在后台跑完，结束后自己把启动器重新拉起来。\n\n现在更新吗？",
                    "检查更新", MessageBoxButton.YesNo, MessageBoxImage.Question);
                if (answer != MessageBoxResult.Yes) return;
            }

            _updating = true;
            BtnUpdate.IsEnabled = false;
            ShowUpdateProgress("正在更新…", -1);
            try
            {
                // 脚本每吐一行进度就回传一次（Progress<T> 会切回 UI 线程）
                var prog = new Progress<UpdateService.Progress>((p) => ShowUpdateProgress(p.Text, p.Percent));
                var err = await UpdateService.ApplyAsync(_sup.BaseDir, prog);
                if (err.Length > 0)
                {
                    HideUpdateProgress();
                    StatusLine.Text = "更新失败：" + err;
                    MessageBox.Show("更新失败：" + err + "\n\n再点一次「检查更新」可以重试（失败会自动回滚）。",
                        "检查更新", MessageBoxButton.OK, MessageBoxImage.Warning);
                    return;
                }

                // 更新完必须重启：跑着的还是旧镜像，旧 exe 也只有等本进程退出才删得掉。
                StatusLine.Text = "已更新到 v" + latest + "，正在重启…";
                await Task.Delay(800);

                // 脚本收尾时会自己把启动器拉起来（带 --replace 本进程 PID）：
                // 它已经在了就只关自己；没在（老脚本）才自己起一个。
                if (AnotherInstanceRunning())
                {
                    Application.Current.Shutdown();
                }
                else if (!RestartSelf(out var restartErr))
                {
                    HideUpdateProgress();
                    StatusLine.Text = "已更新到 v" + latest + "，请手动重新打开";
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

        /// <summary>进度条 + 一句话。Percent &lt; 0 时走不确定态（解压/备份这种没有百分比的步骤）。</summary>
        private void ShowUpdateProgress(string text, double percent)
        {
            if (!string.IsNullOrEmpty(text)) StatusLine.Text = text;
            UpdateBar.Visibility = Visibility.Visible;
            if (percent < 0)
            {
                UpdateBar.IsIndeterminate = true;
                UpdatePct.Visibility = Visibility.Collapsed;
            }
            else
            {
                UpdateBar.IsIndeterminate = false;
                UpdateBar.Value = Math.Max(0, Math.Min(100, percent));
                UpdatePct.Text = (int)percent + "%";
                UpdatePct.Visibility = Visibility.Visible;
            }
        }

        private void HideUpdateProgress()
        {
            UpdateBar.Visibility = Visibility.Collapsed;
            UpdatePct.Visibility = Visibility.Collapsed;
        }

        /// <summary>是不是已经有新实例被脚本拉起来了（含自己）。</summary>
        private static bool AnotherInstanceRunning()
        {
            try
            {
                var name = Path.GetFileNameWithoutExtension(Environment.ProcessPath ?? "");
                if (string.IsNullOrEmpty(name)) return false;
                return Process.GetProcessesByName(name).Length > 1;
            }
            catch { return false; }
        }

        /// <summary>更新中关窗口：说清楚关掉也不会中断，让用户自己决定。</summary>
        private void OnClosingDuringUpdate(object sender, System.ComponentModel.CancelEventArgs e)
        {
            if (!_updating) return;
            var ans = MessageBox.Show(
                "更新还在进行。\n\n" +
                "关掉窗口不会中断更新：脚本会继续在后台跑完，结束后自动把启动器重新打开。\n\n现在关吗？",
                "更新进行中", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (ans != MessageBoxResult.Yes) e.Cancel = true;
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
                    _sup.SayError("页面创建失败（" + key + "）：" + ex.Message);
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
                case "语音发送": return new VoiceSendPage(_sup);
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
                _sup.SayWarn("打开数据目录失败：" + ex.Message);
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
                // 更新期间这行归更新流程管，别被两秒一次的刷新覆盖掉
                if (!_updating) StatusLine.Text = parts.Count > 0 ? string.Join(" · ", parts) : "启动器就绪";

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
