using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace WhaleLauncher.Views
{
    public partial class DiagPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly DispatcherTimer _timer;
        private int _lastCount = -1;
        private string _lastLogSig = "";
        private string _nodeVersion = "";
        private string _pythonVersion = "";
        private bool _versionsLoaded;

        // 路径卡的目录求大小要递归整个安装目录（数万文件），缓存一下别每次都算（H9）
        private DateTime _lastPaths = DateTime.MinValue;
        private readonly Dictionary<string, (DateTime At, string Text)> _sizeCache = new Dictionary<string, (DateTime At, string Text)>();

        public DiagPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            CmbTail.SelectedIndex = 0;

            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.5) };
            _timer.Tick += (_, __) => RenderLogs();
            _timer.Start();

            Unloaded += (_, __) => _timer.Stop();
            Loaded += async (_, __) =>
            {
                if (!_timer.IsEnabled) _timer.Start();
                await RefreshAsync();
            };
        }

        public async Task RefreshAsync()
        {
            var s = await _sup.ProbeAsync();
            await CheckAsync(s);
            await RenderPathsAsync();      // 内部 ≥5 秒节流 + 后台求大小（H9）
            await LoadVersionsAsync();

            RuntimeInfo.Text =
                $"内核 node {_nodeVersion}（{(s.NodeUp ? "运行中" : "未运行")}）\n" +
                $"桥接 python {_pythonVersion}（{(s.BrOnline ? "在线" : "离线")}）\n" +
                $"端口 {s.Port} · 数据目录 {_sup.DataDir}";

            // 日志统一由本页 1.5 秒定时器驱动，这里不再重复 RenderLogs（L16：双通道驱动整表重建）
        }

        // ── 自检 ────────────────────────────────────────────────
        private async Task CheckAsync(Snapshot s)
        {
            CheckHost.Children.Clear();
            var data = _sup.DataDir;

            AddCheck("内核在跑", s.NodeUp, s.NodeUp ? $"端口 {s.Port}，已跑 {s.UptimeSec} 秒" : "点顶栏 ⏻ 启动");

            var py = Path.Combine(_sup.BaseDir, "runtime", "python", "python.exe");
            AddCheck("桥接在线", s.BrOnline, s.BrOnline
                ? (s.BrLastSeenSec >= 0 ? $"心跳 {s.BrLastSeenSec} 秒前" : "已连上")
                : "没心跳：看「微信 · 桥接」页的控制台");

            var sp = Path.Combine(_sup.BaseDir, "runtime", "python", "Lib", "site-packages");
            var pkgCount = 0;
            try { if (Directory.Exists(sp)) pkgCount = Directory.GetDirectories(sp).Length; } catch { }
            AddCheck("Python 依赖", pkgCount >= 20, pkgCount + " 个包已预装");

            var admin = IsAdmin();
            AddCheck("管理员权限", admin, admin
                ? "当前是管理员，和微信同级，零焦点发送可用"
                : "不是管理员。微信若是管理员运行的，零焦点发送会被 UIPI 挡掉");

            AddCheck("UIA 可用", s.BrUia, s.BrUia ? "能读到微信窗口树" : "读不到：微信可能最小化，或桥接没起");
            AddCheck("模型 Key", !s.NeedsKey || s.HasKey || s.Mock, !s.NeedsKey ? "当前模型不需要 Key" : s.Mock ? "演示模式（不连模型）" : (s.HasKey ? "已配置" : "去「设置」填 Key"));

            var hasWheel = Directory.Exists(Path.Combine(_sup.BaseDir, "runtime", "wheelhouse"));
            if (hasWheel) AddCheck("打包完整性", false, "runtime\\wheelhouse 还在，安装包会白白大 117MB");

            // 运行时清单：node / python / manifest 三件事合并成一条，不再单列两行
            var nodeExe = Path.Combine(_sup.BaseDir, "runtime", "node.exe");
            var manifest = Path.Combine(_sup.BaseDir, "runtime", "manifest.json");
            var hasNode = File.Exists(nodeExe);
            var hasPy = File.Exists(py);
            var missing = new List<string>();
            if (!hasNode) missing.Add("runtime\\node.exe");
            if (!hasPy) missing.Add("runtime\\python\\python.exe");
            var detail = missing.Count > 0
                ? "缺 " + string.Join(" 和 ", missing)
                : (File.Exists(manifest)
                    ? "node 与 python 都在，manifest.json 已就位"
                    : "node 与 python 都在（旧版运行时包，无 manifest.json）");
            AddCheck("运行时清单", missing.Count == 0, detail);
        }

        private void AddCheck(string name, bool ok, string detail)
        {
            // 两行式：第一行 ✓ + 名称，第二行灰字说明。项数少了，一屏放得下，不需要滚动区。
            var row = new Grid { Margin = new Thickness(0, 0, 0, 8) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var mark = new TextBlock
            {
                Text = ok ? "✓" : "✕",
                Foreground = ok ? (Brush)FindResource("Ok") : (Brush)FindResource("Bad"),
                FontSize = 13,
                FontWeight = FontWeights.Bold,
                VerticalAlignment = VerticalAlignment.Top
            };
            row.Children.Add(mark);

            var stack = new StackPanel();
            stack.Children.Add(new TextBlock
            {
                Text = name,
                Foreground = (Brush)FindResource("Text"),
                FontSize = 12.5
            });
            stack.Children.Add(new TextBlock
            {
                Text = detail,
                Style = (Style)FindResource("Small"),
                Foreground = (Brush)FindResource("Muted"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 2, 0, 0)
            });
            Grid.SetColumn(stack, 1);
            row.Children.Add(stack);

            CheckHost.Children.Add(row);
        }

        private static bool IsAdmin()
        {
            try
            {
                using var id = WindowsIdentity.GetCurrent();
                return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
            }
            catch { return false; }
        }

        // ── 路径 ────────────────────────────────────────────────
        /// <summary>
        /// 路径卡。目录求大小以前每 2 秒在 UI 线程递归整个安装目录，一打开诊断页就卡死（H9）：
        /// 现在求大小走 Task.Run + 缓存 45 秒，整个渲染 ≥5 秒才做一次（照 SettingsPage 的节流做法）。
        /// </summary>
        private async Task RenderPathsAsync()
        {
            if ((DateTime.Now - _lastPaths).TotalSeconds < 5) return;   // 节流：≥5 秒一次
            _lastPaths = DateTime.Now;

            PathsHost.Children.Clear();
            var items = new (string Label, string Path)[]
            {
                ("数据", _sup.DataDir),
                ("配置", Path.Combine(_sup.BaseDir, "config.json")),
                ("启动器日志", Path.Combine(_sup.DataDir, "launcher.log")),
                // 内核和桥接自己写的全量日志（debug），出问题时先看这两个
                ("内核日志", Path.Combine(_sup.DataDir, "whale.log")),
                ("桥接日志", Path.Combine(_sup.DataDir, "wechat-bridge-4x.log")),
                ("备份", Path.Combine(_sup.DataDir, "backups")),
                ("安装目录", _sup.BaseDir),
            };

            var fills = new List<Task>();
            foreach (var (label, path) in items)
            {
                var row = new DockPanel { Margin = new Thickness(0, 0, 0, 4), LastChildFill = false };
                row.Children.Add(new TextBlock
                {
                    Text = label,
                    Style = (Style)FindResource("Small"),
                    Width = 62,
                    VerticalAlignment = VerticalAlignment.Center
                });
                var size = new TextBlock
                {
                    Style = (Style)FindResource("Small"),
                    HorizontalAlignment = HorizontalAlignment.Right,
                    VerticalAlignment = VerticalAlignment.Center,
                    ToolTip = path                 // 只显示大小，不提供点击跳转
                };
                DockPanel.SetDock(size, Dock.Right);
                row.Children.Add(size);
                PathsHost.Children.Add(row);
                fills.Add(FillSizeAsync(size, path));
            }
            await Task.WhenAll(fills);
        }

        /// <summary>算完大小回到 UI 线程再改文字。</summary>
        private async Task FillSizeAsync(TextBlock target, string path)
        {
            target.Text = await SizeOfAsync(path);
        }

        /// <summary>求大小挪到后台线程算，结果缓存 45 秒（30-60 秒内都算合理）。</summary>
        private async Task<string> SizeOfAsync(string path)
        {
            if (_sizeCache.TryGetValue(path, out var hit) && (DateTime.Now - hit.At).TotalSeconds < 45)
                return hit.Text;
            var text = await Task.Run(() => SizeOf(path));   // 递归枚举放后台线程，别冻 UI
            _sizeCache[path] = (DateTime.Now, text);
            return text;
        }

        private static string SizeOf(string path)
        {
            try
            {
                if (File.Exists(path)) return new FileInfo(path).Length / 1024 + " KB";
                if (Directory.Exists(path))
                {
                    var bytes = Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories).Sum(f =>
                    {
                        try { return new FileInfo(f).Length; } catch { return 0L; }
                    });
                    return bytes > 1024 * 1024 ? (bytes / 1024 / 1024) + " MB" : (bytes / 1024) + " KB";
                }
                return "不存在";
            }
            catch { return "?"; }
        }

        // ── 版本 ────────────────────────────────────────────────
        private async Task LoadVersionsAsync()
        {
            if (_versionsLoaded) return;
            _versionsLoaded = true;
            _nodeVersion = await VersionOf(Path.Combine(_sup.BaseDir, "runtime", "node.exe"), "--version");
            _pythonVersion = await VersionOf(Path.Combine(_sup.BaseDir, "runtime", "python", "python.exe"), "-V");
        }

        private static async Task<string> VersionOf(string exe, string arg)
        {
            if (!File.Exists(exe)) return "（未找到）";
            try
            {
                var psi = new ProcessStartInfo(exe, arg)
                {
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using var p = Process.Start(psi);
                var text = await p.StandardOutput.ReadToEndAsync();
                var err = await p.StandardError.ReadToEndAsync();
                p.WaitForExit(3000);
                var ver = (text + " " + err).Trim().Split('\n')[0].Trim();
                return string.IsNullOrEmpty(ver) ? "?" : ver;
            }
            catch { return "?"; }
        }

        // ── 日志 ────────────────────────────────────────────────
        private void RenderLogs()
        {
            if (Logs == null) return;
            var rows = new List<ConsoleRow>();
            var all = _sup.History(5000);
            var tail = CmbTail.SelectedIndex switch { 0 => 500, 1 => 2000, _ => 5000 };
            var onlyErr = ChkErrors.IsChecked == true;
            var q = (TxtSearch.Text ?? "").Trim();

            foreach (var l in all)
            {
                if (l.Src == "B") continue;              // 桥接日志在合并页
                rows.Add(new ConsoleRow
                {
                    TimeText = l.At.ToString("HH:mm:ss"),
                    LevelChar = l.Level.ToString(),
                    Src = l.Src,
                    Text = l.Text
                });
            }

            var filtered = rows
                .Where(r => !onlyErr || r.LevelChar != "i")
                .Where(r => q.Length == 0 || (r.Text ?? "").IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0)
                .ToList();
            if (filtered.Count > tail) filtered = filtered.Skip(filtered.Count - tail).ToList();

            // 内容没变就不动 ItemsSource：整表重建会把滚动位置和选中弄丢（L16）。
            // 日志只追加，比较行数 + 首尾两行就够判断有没有新内容。
            var sig = filtered.Count + "|"
                + (filtered.Count > 0 ? filtered[0].TimeText + filtered[0].Text : "") + "|"
                + (filtered.Count > 0 ? filtered[filtered.Count - 1].TimeText + filtered[filtered.Count - 1].Text : "");
            if (sig == _lastLogSig && Logs.ItemsSource != null) return;
            _lastLogSig = sig;

            Logs.ItemsSource = filtered;
            if (filtered.Count > 0 && filtered.Count != _lastCount)
                Logs.ScrollIntoView(filtered[filtered.Count - 1]);
            _lastCount = filtered.Count;
        }

        private void OnFilterChanged(object sender, RoutedEventArgs e) => RenderLogs();

        private void OnSearchChanged(object sender, TextChangedEventArgs e) => RenderLogs();

        private void OnTailChanged(object sender, SelectionChangedEventArgs e) => RenderLogs();

        private void OnClear(object sender, RoutedEventArgs e)
        {
            _lastCount = -1;
            _lastLogSig = "";
            Logs.ItemsSource = null;
        }

        private void OnCopy(object sender, RoutedEventArgs e)
        {
            try
            {
                var rows = Logs.ItemsSource as List<ConsoleRow> ?? new List<ConsoleRow>();
                Clipboard.SetText(string.Join(Environment.NewLine, rows.Select(r => $"{r.TimeText} {r.LevelChar} {r.Src} {r.Text}")));
            }
            catch { }
        }

        private async void OnRecheck(object sender, RoutedEventArgs e)
        {
            var s = await _sup.ProbeAsync();
            await CheckAsync(s);
        }

        // ── 日志导出（最近三次启动） ─────────────────────────────
        private void OnExport(object sender, RoutedEventArgs e)
        {
            try
            {
                var name = "logs-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".zip";
                var path = Path.Combine(_sup.DataDir, name);
                Directory.CreateDirectory(_sup.DataDir);

                var runs = new List<string>();
                var logsRoot = Path.Combine(_sup.DataDir, "logs");
                if (Directory.Exists(logsRoot))
                    runs.AddRange(Directory.GetDirectories(logsRoot, "run-*")
                        .OrderByDescending(d => d).Take(3));

                var sb = new StringBuilder();
                sb.AppendLine("鲸鲸 4.0 日志包（最近三次启动）");
                sb.AppendLine("时间: " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
                sb.AppendLine("安装目录: " + _sup.BaseDir);
                sb.AppendLine("管理员: " + IsAdmin());
                sb.AppendLine("内核: " + _sup.NodeRunning + "  桥接: " + _sup.BridgeRunning + "  端口: " + _sup.Port);
                sb.AppendLine("日志级别: " + ReadLogLevel());
                sb.AppendLine("归档的启动次数: " + runs.Count);
                sb.AppendLine("不含 config.json（里面是 Key）。");
                sb.AppendLine();
                sb.AppendLine("目录说明：logs/run-*/ 是历史启动，logs/current/ 是这次正在跑的。");

                using (var zip = ZipFile.Open(path, ZipArchiveMode.Create))
                {
                    void AddText(string entry, string content)
                    {
                        var item = zip.CreateEntry(entry, CompressionLevel.Optimal);
                        using var w = new StreamWriter(item.Open(), new UTF8Encoding(false));
                        w.Write(content);
                    }
                    void AddFile(string entry, string file)
                    {
                        try
                        {
                            if (File.Exists(file) && new FileInfo(file).Length > 0)
                                zip.CreateEntryFromFile(file, entry, CompressionLevel.Optimal);
                        }
                        catch { /* 正在写的文件可能被占用，跳过就好 */ }
                    }

                    AddText("info.txt", sb.ToString());
                    foreach (var run in runs)
                    {
                        var tag = "logs/" + Path.GetFileName(run) + "/";
                        foreach (var f in Directory.GetFiles(run))
                            AddFile(tag + Path.GetFileName(f), f);
                    }
                    foreach (var f in new[] { "launcher.log", "bridge.log", "kernel.log", "whale.log" })
                        AddFile("logs/current/" + f, Path.Combine(_sup.DataDir, f));

                    // wechatauto 库自己的日志：最近两天的也带上，桥接层的错常在这里露出
                    var wa = Path.Combine(_sup.BaseDir, "wechatauto_logs");
                    if (Directory.Exists(wa))
                        foreach (var f in Directory.GetFiles(wa, "*.log").OrderByDescending(x => x).Take(2))
                            AddFile("wechatauto_logs/" + Path.GetFileName(f), f);
                }
                Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show("导出失败：" + ex.Message, "日志包");
            }
        }

        private string ReadLogLevel()
        {
            try
            {
                var file = Path.Combine(_sup.BaseDir, "config.json");
                if (!File.Exists(file)) return "info";
                using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(file));
                if (doc.RootElement.TryGetProperty("log", out var log)
                    && log.TryGetProperty("level", out var lv) && lv.ValueKind == System.Text.Json.JsonValueKind.String)
                    return lv.GetString() ?? "info";
            }
            catch { }
            return "info";
        }
    }
}
