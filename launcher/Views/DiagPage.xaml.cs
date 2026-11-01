using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
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

        private void OnOpenDataDir(object sender, RoutedEventArgs e)
        {
            try
            {
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + _sup.DataDir + "\"") { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show("打开数据目录失败：" + ex.Message, "数据目录");
            }
        }

        private async void OnRecheck(object sender, RoutedEventArgs e)
        {
            var s = await _sup.ProbeAsync();
            await CheckAsync(s);
        }

        // ── 日志导出（debug 日志包） ────────────────────────────
        // 顶栏按钮只负责弹浮窗；浮窗里两个选项各自选时间范围，然后走同一个导出流程。
        private enum LogRange { Recent10Min, ThisRun }

        private static readonly string[] LogFiles = { "launcher.log", "bridge.log", "kernel.log", "whale.log" };

        // 日志行首时间戳：whale.log 是 [yyyy-MM-dd HH:mm:ss]，启动器自己写的是裸 HH:mm:ss
        private static readonly Regex StampFull = new Regex(@"^\[?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})", RegexOptions.Compiled);
        private static readonly Regex StampClock = new Regex(@"^\[?(\d{2}:\d{2}:\d{2})", RegexOptions.Compiled);

        // 脱敏用：键名命中这些词的，值一律换成 "***"（结构保留）
        private static readonly Regex SecretKey =
            new Regex("apiKey|apikey|key|token|secret|password|cookie|session", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private bool _exporting;

        /// <summary>顶栏「导出日志」：在按钮下方弹出浮窗。</summary>
        private void OnExport(object sender, RoutedEventArgs e)
        {
            // StaysOpen=False 会先因这次点击把浮窗关掉，所以这里直接置 true（重复点击就是重新展开）
            ExportPopup.IsOpen = true;
        }

        private async void OnExportRecent10(object sender, RoutedEventArgs e)
        {
            ExportPopup.IsOpen = false;
            await ExportAsync(LogRange.Recent10Min);
        }

        private async void OnExportThisRun(object sender, RoutedEventArgs e)
        {
            ExportPopup.IsOpen = false;
            await ExportAsync(LogRange.ThisRun);
        }

        /// <summary>
        /// 导出流程：UI 线程只做 await，重活（读日志、跑 doctor、压 zip）都在后台线程，别把界面冻住。
        /// </summary>
        private async Task ExportAsync(LogRange range)
        {
            if (_exporting) return;
            _exporting = true;
            BtnExport.IsEnabled = false;
            try
            {
                await LoadVersionsAsync();                       // node / python 版本，内部有缓存
                var probe = await _sup.ProbeAsync();             // 内核/桥接在线情况
                var status = await Api.Get(_sup.Url, "/api/status");
                var settings = await Api.Get(_sup.Url, "/api/settings");
                var doctor = await RunDoctorAsync();             // 15 秒超时，失败只写原因

                var path = await Task.Run(() => WritePackage(range, probe, status, settings, doctor));
                Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show("导出失败：" + ex.Message, "日志包");
            }
            finally
            {
                BtnExport.IsEnabled = true;
                _exporting = false;
            }
        }

        /// <summary>在后台线程组装 zip。返回 zip 的绝对路径。</summary>
        private string WritePackage(LogRange range, Snapshot probe, ApiResult status, ApiResult settings, string doctor)
        {
            var name = "logs-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".zip";
            var path = Path.Combine(_sup.DataDir, name);
            Directory.CreateDirectory(_sup.DataDir);

            var skipped = new List<string>();

            // 先收集日志和配置（info.txt 里要写「哪些文件读失败了」，所以得排在 info.txt 之前）
            var logs = CollectLogs(range, skipped);
            var config = RedactedJson(Path.Combine(_sup.BaseDir, "config.json"), skipped);
            var settingsRedacted = RedactedJson(Path.Combine(_sup.DataDir, "settings.json"), skipped);
            var waFiles = WechatAutoLogs();

            using (var zip = ZipFile.Open(path, ZipArchiveMode.Create))
            {
                AddText(zip, "README.txt", BuildReadme(range));
                AddText(zip, "info.txt", BuildInfo(range, probe, skipped));
                AddText(zip, "status.json", BuildStatus(status, settings));
                AddText(zip, "doctor.txt", doctor);
                if (config != null) AddText(zip, "config.redacted.json", config);
                if (settingsRedacted != null) AddText(zip, "settings.redacted.json", settingsRedacted);

                foreach (var (entry, text) in logs)
                    AddText(zip, entry, text);

                // wechatauto 库自己的日志：最近两天的也带上，桥接层的错常在这里露出
                foreach (var f in waFiles)
                {
                    try { zip.CreateEntryFromFile(f, "wechatauto_logs/" + Path.GetFileName(f), CompressionLevel.Optimal); }
                    catch (Exception ex) { skipped.Add(Path.GetFileName(f) + "：" + ex.Message); }
                }
            }

            return path;
        }

        // ── 日志收集 ────────────────────────────────────────────
        private List<(string Entry, string Text)> CollectLogs(LogRange range, List<string> skipped)
        {
            var result = new List<(string, string)>();

            void AddCurrentFull(string file)
            {
                var text = ReadShared(file, skipped);
                if (!string.IsNullOrEmpty(text)) result.Add(("logs/current/" + Path.GetFileName(file), text));
            }

            if (range == LogRange.ThisRun)
            {
                // 当前这次启动的日志就写在 data/ 下四个文件里。
                // 不在运行时，这四个文件就是「最近一次启动」的；四个都空（刚启动还没写）才退回归档目录。
                var anyContent = LogFiles.Any(f => FileLen(Path.Combine(_sup.DataDir, f)) > 0);
                if (anyContent || _sup.NodeRunning || _sup.BridgeRunning)
                {
                    foreach (var f in LogFiles) AddCurrentFull(Path.Combine(_sup.DataDir, f));
                }
                else
                {
                    var latest = LatestRunDir();
                    if (latest == null)
                    {
                        foreach (var f in LogFiles) AddCurrentFull(Path.Combine(_sup.DataDir, f));
                    }
                    else
                    {
                        foreach (var f in SafeFiles(latest))
                        {
                            var text = ReadShared(f, skipped);
                            if (!string.IsNullOrEmpty(text))
                                result.Add(("logs/" + Path.GetFileName(latest) + "/" + Path.GetFileName(f), text));
                        }
                    }
                }
                return result;
            }

            // 最近 10 分钟：当前四个文件 + 所有 run-* 归档，按行首时间戳过滤
            var cutoff = DateTime.Now.AddMinutes(-10);
            foreach (var f in LogFiles)
                AddRecent(result, "logs/current/" + f, Path.Combine(_sup.DataDir, f), cutoff, skipped);
            foreach (var run in RunDirs())
                foreach (var f in SafeFiles(run))
                    AddRecent(result, "logs/" + Path.GetFileName(run) + "/" + Path.GetFileName(f), f, cutoff, skipped);

            return result;
        }

        /// <summary>最近 10 分钟模式：留时间戳在窗口内的行；解析不出时间戳的行原样留在文件里。</summary>
        private static void AddRecent(List<(string, string)> target, string entry, string file, DateTime cutoff, List<string> skipped)
        {
            if (!File.Exists(file)) return;
            DateTime mtime;
            try { mtime = File.GetLastWriteTime(file); } catch { mtime = DateTime.Now; }

            try
            {
                using var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var sr = new StreamReader(fs, Encoding.UTF8, true);
                var kept = new StringBuilder();
                var inWindow = 0;                 // 窗口内的行数：一行都没有且文件早就不动了，整个文件跳过
                string line;
                while ((line = sr.ReadLine()) != null)
                {
                    var at = ParseStamp(line, mtime.Date);
                    if (at.HasValue)
                    {
                        if (at.Value < cutoff) continue;
                        inWindow++;
                    }
                    kept.AppendLine(line);
                }
                if (inWindow == 0 && mtime < cutoff) return;
                if (kept.Length == 0) return;
                target.Add((entry, kept.ToString()));
            }
            catch (Exception ex)
            {
                skipped.Add(Path.GetFileName(file) + "：" + ex.Message);
            }
        }

        private static DateTime? ParseStamp(string line, DateTime fileDate)
        {
            if (string.IsNullOrEmpty(line)) return null;
            var s = line.TrimStart('\uFEFF', ' ', '\t');
            var m = StampFull.Match(s);
            if (m.Success && DateTime.TryParseExact(m.Groups[1].Value + " " + m.Groups[2].Value,
                    "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out var at))
                return at;
            var c = StampClock.Match(s);
            if (c.Success && TimeSpan.TryParse(c.Groups[1].Value, CultureInfo.InvariantCulture, out var ts))
                return fileDate.Add(ts);
            return null;
        }

        /// <summary>共享读：正在被内核/桥接写的日志也能读，读不到就记一笔跳过，不让整个导出失败。</summary>
        private static string ReadShared(string file, List<string> skipped)
        {
            if (!File.Exists(file)) return null;
            try
            {
                using var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var sr = new StreamReader(fs, Encoding.UTF8, true);
                return sr.ReadToEnd();
            }
            catch (Exception ex)
            {
                skipped.Add(Path.GetFileName(file) + "：" + ex.Message);
                return null;
            }
        }

        private static long FileLen(string file)
        {
            try { return File.Exists(file) ? new FileInfo(file).Length : 0; } catch { return 0; }
        }

        private static string[] SafeFiles(string dir)
        {
            try { return Directory.GetFiles(dir); } catch { return Array.Empty<string>(); }
        }

        private string LatestRunDir()
        {
            try
            {
                var root = Path.Combine(_sup.DataDir, "logs");
                if (!Directory.Exists(root)) return null;
                return Directory.GetDirectories(root, "run-*")
                    .OrderByDescending(d => Path.GetFileName(d), StringComparer.OrdinalIgnoreCase)
                    .FirstOrDefault();
            }
            catch { return null; }
        }

        private IEnumerable<string> RunDirs()
        {
            try
            {
                var root = Path.Combine(_sup.DataDir, "logs");
                if (Directory.Exists(root))
                    return Directory.GetDirectories(root, "run-*")
                        .OrderByDescending(d => Path.GetFileName(d), StringComparer.OrdinalIgnoreCase)
                        .ToList();
            }
            catch { }
            return Array.Empty<string>();
        }

        private List<string> WechatAutoLogs()
        {
            var list = new List<string>();
            try
            {
                var wa = Path.Combine(_sup.BaseDir, "wechatauto_logs");
                if (!Directory.Exists(wa)) return list;
                var since = DateTime.Now.AddDays(-2);
                list.AddRange(Directory.GetFiles(wa, "*.log")
                    .Where(f => File.GetLastWriteTime(f) >= since)
                    .OrderByDescending(File.GetLastWriteTime)
                    .Take(20));
            }
            catch { }
            return list;
        }

        // ── zip 内容 ────────────────────────────────────────────
        private static void AddText(ZipArchive zip, string entry, string content)
        {
            var item = zip.CreateEntry(entry, CompressionLevel.Optimal);
            using var w = new StreamWriter(item.Open(), new UTF8Encoding(false));   // UTF-8 无 BOM
            w.Write(content ?? "");
        }

        private static string BuildReadme(LogRange range)
        {
            var sb = new StringBuilder();
            sb.AppendLine("鲸鲸 · debug 日志包");
            sb.AppendLine("==================================================");
            sb.AppendLine("这是排查问题用的 debug 日志包，不是给日常使用的日志。");
            sb.AppendLine("时间范围：" + (range == LogRange.Recent10Min ? "最近 10 分钟" : "当次启动（含本次启动的全部日志）"));
            sb.AppendLine();
            sb.AppendLine("包含内容：");
            sb.AppendLine("  README.txt            本文件");
            sb.AppendLine("  info.txt              运行环境、内核/桥接状态、各项大小与磁盘剩余");
            sb.AppendLine("  config.redacted.json  config.json 的完整副本，敏感值已脱敏");
            sb.AppendLine("  settings.redacted.json data/settings.json 的副本，敏感值已脱敏");
            sb.AppendLine("  status.json           /api/status 与 /api/settings 的原始返回");
            sb.AppendLine("  doctor.txt            node server.js --doctor 的输出（尽力而为）");
            sb.AppendLine("  logs/                 各日志文件（logs/current/ 是这一次，logs/run-*/ 是历史启动）");
            sb.AppendLine("  wechatauto_logs/      微信自动化库最近两天的日志");
            sb.AppendLine();
            sb.AppendLine("关于脱敏：");
            sb.AppendLine("  键名匹配 apiKey / key / token / secret / password / cookie / session 的值都换成了 \"***\"，");
            sb.AppendLine("  配置结构、非敏感字段和模型名都原样保留，方便对齐配置。日志正文没有做脱敏处理。");
            sb.AppendLine();
            sb.AppendLine("遇到问题时，把整个 zip 原样发给对方即可，不用自己挑文件。");
            return sb.ToString();
        }

        private string BuildInfo(LogRange range, Snapshot probe, List<string> skipped)
        {
            var (level, fileLevel) = ReadLogLevels();
            var (provider, model, vision) = ReadModelInfo();
            if (provider.Length == 0) provider = probe?.Provider ?? "";
            if (model.Length == 0) model = probe?.Model ?? "";

            var sb = new StringBuilder();
            sb.AppendLine("鲸鲸 debug 日志包 · info");
            sb.AppendLine("==================================================");
            sb.AppendLine("导出时间        : " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "（时区 " + TimeZoneInfo.Local.Id + "）");
            sb.AppendLine("导出范围        : " + (range == LogRange.Recent10Min ? "最近 10 分钟" : "当次启动"));
            sb.AppendLine("启动器版本      : " + LauncherVersion());
            sb.AppendLine("操作系统        : " + SafeOsText());
            sb.AppendLine("系统架构        : " + RuntimeInformation.OSArchitecture + " / 进程 " + RuntimeInformation.ProcessArchitecture
                          + (Environment.Is64BitProcess ? "（64 位进程）" : "（32 位进程）"));
            sb.AppendLine(".NET 运行时     : " + RuntimeInformation.FrameworkDescription + "（Environment.Version " + Environment.Version + "）");
            sb.AppendLine("内核            : " + (probe?.NodeUp == true ? "运行中" : "未运行") + "，端口 " + _sup.Port);
            sb.AppendLine("桥接            : " + (probe?.BrOnline == true ? "在线"
                                  : probe?.BridgeUp == true ? "已启动但没心跳" : "未运行"));
            sb.AppendLine("管理员          : " + (IsAdmin() ? "是" : "否"));
            sb.AppendLine("日志级别        : log.level=" + level + "，log.fileLevel=" + (fileLevel.Length > 0 ? fileLevel : "未配置"));
            sb.AppendLine("当前模型服务    : " + (provider.Length > 0 ? provider : "未知"));
            sb.AppendLine("当前模型名      : " + (model.Length > 0 ? model : "未知"));
            sb.AppendLine("看图模型名      : " + (vision.Length > 0 ? vision : "未知"));
            sb.AppendLine("Node            : " + VersionOrUnknown(_nodeVersion));
            sb.AppendLine("Python          : " + VersionOrUnknown(_pythonVersion));
            sb.AppendLine("安装目录        : " + _sup.BaseDir);
            sb.AppendLine("数据目录        : " + _sup.DataDir);
            sb.AppendLine();
            sb.AppendLine("各日志文件大小：");
            foreach (var f in LogFiles)
                sb.AppendLine("  data/" + f.PadRight(16) + SizeText(FileLen(Path.Combine(_sup.DataDir, f))));
            sb.AppendLine("  data/wechat-bridge-4x.log  " + SizeText(FileLen(Path.Combine(_sup.DataDir, "wechat-bridge-4x.log"))));
            sb.AppendLine("磁盘剩余        : " + DiskFreeText());
            sb.AppendLine("run-* 归档数量  : " + RunDirs().Count() + " 份（data/logs 下，启动器保留最近 5 份）");
            sb.AppendLine();
            if (skipped.Count == 0)
            {
                sb.AppendLine("读取失败 / 跳过的文件：无");
            }
            else
            {
                sb.AppendLine("读取失败 / 跳过的文件：");
                foreach (var s in skipped.Distinct()) sb.AppendLine("  - " + s);
            }
            return sb.ToString();
        }

        private string BuildStatus(ApiResult status, ApiResult settings)
        {
            var root = new JsonObject
            {
                ["exportedAt"] = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
                ["status"] = ToJsonNode(status),
                ["settings"] = ToJsonNode(settings)
            };
            return root.ToJsonString(new JsonSerializerOptions
            {
                WriteIndented = true,
                Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
            }) + Environment.NewLine;
        }

        private static JsonNode ToJsonNode(ApiResult r)
        {
            if (r == null) return JsonValue.Create("（没有返回）");
            if (!string.IsNullOrWhiteSpace(r.Raw))
            {
                try { return JsonNode.Parse(r.Raw); } catch { return JsonValue.Create(r.Raw); }
            }
            var err = "错误" + (r.StatusCode > 0 ? "（HTTP " + r.StatusCode + "）" : "") + "：" + (string.IsNullOrEmpty(r.Error) ? "空返回" : r.Error);
            return JsonValue.Create(err);
        }

        private string LauncherVersion()
        {
            // 和 MainWindow 读版本的方式一致：优先 package.json，没有再退回程序集版本
            try
            {
                var vp = Path.Combine(_sup.BaseDir, "package.json");
                if (File.Exists(vp))
                {
                    var m = Regex.Match(File.ReadAllText(vp), "\"version\"\\s*:\\s*\"([^\"]+)\"");
                    if (m.Success) return "v" + m.Groups[1].Value + "-alpha";
                }
            }
            catch { }
            try
            {
                var v = typeof(DiagPage).Assembly.GetName().Version;
                return v != null ? v.ToString() : "未知";
            }
            catch { return "未知"; }
        }

        private static string SafeOsText()
        {
            try { return RuntimeInformation.OSDescription; } catch { return Environment.OSVersion.ToString(); }
        }

        private static string VersionOrUnknown(string v)
            => string.IsNullOrWhiteSpace(v) || v == "?" || v.Contains("未找到", StringComparison.Ordinal) ? "未知" : v;

        private static string SizeText(long bytes)
        {
            if (bytes <= 0) return "0 字节（不存在或为空）";
            if (bytes < 1024) return bytes + " 字节";
            return bytes < 1024 * 1024
                ? (bytes / 1024.0).ToString("0.0", CultureInfo.InvariantCulture) + " KB"
                : (bytes / 1024.0 / 1024.0).ToString("0.0", CultureInfo.InvariantCulture) + " MB";
        }

        private string DiskFreeText()
        {
            try
            {
                var rootPath = Path.GetPathRoot(Path.GetFullPath(_sup.DataDir));
                var d = new DriveInfo(rootPath);
                return (d.AvailableFreeSpace / 1024.0 / 1024.0 / 1024.0).ToString("0.0", CultureInfo.InvariantCulture)
                    + " GB 可用 / 共 " + (d.TotalSize / 1024.0 / 1024.0 / 1024.0).ToString("0.0", CultureInfo.InvariantCulture)
                    + " GB（" + d.Name + "）";
            }
            catch (Exception ex) { return "未知（" + ex.Message + "）"; }
        }

        // ── doctor / 脱敏 / 配置读取 ─────────────────────────────
        /// <summary>尽力而为：有 node 就跑 server.js --doctor，15 秒超时，失败只写原因。</summary>
        private async Task<string> RunDoctorAsync()
        {
            var sb = new StringBuilder();
            sb.AppendLine("$ node server.js --doctor");
            sb.AppendLine("工作目录: " + _sup.BaseDir);
            sb.AppendLine(new string('-', 60));

            var candidates = new List<string>();
            var local = Path.Combine(_sup.BaseDir, "runtime", "node.exe");
            if (File.Exists(local)) candidates.Add(local);
            candidates.Add("node");   // PATH 里的 node

            foreach (var exe in candidates)
            {
                try
                {
                    var psi = new ProcessStartInfo(exe, "server.js --doctor")
                    {
                        WorkingDirectory = _sup.BaseDir,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        StandardOutputEncoding = Encoding.UTF8,
                        StandardErrorEncoding = Encoding.UTF8
                    };
                    using var p = new Process { StartInfo = psi };
                    p.Start();

                    // 两路一起读，避免缓冲区写满卡住子进程
                    var stdout = p.StandardOutput.ReadToEndAsync();
                    var stderr = p.StandardError.ReadToEndAsync();

                    var exited = true;
                    using (var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15)))
                    {
                        try { await p.WaitForExitAsync(cts.Token); }
                        catch (OperationCanceledException) { exited = false; }
                    }
                    if (!exited)
                    {
                        try { p.Kill(true); } catch { }
                        sb.AppendLine("【超时】15 秒内没跑完，已终止（doctor 本身卡住也是有用信息）。");
                    }

                    var so = "";
                    var se = "";
                    try { so = await stdout.WaitAsync(TimeSpan.FromSeconds(5)); } catch { so = "（读 stdout 超时）"; }
                    try { se = await stderr.WaitAsync(TimeSpan.FromSeconds(5)); } catch { se = "（读 stderr 超时）"; }

                    sb.AppendLine("--- stdout ---");
                    sb.AppendLine(so);
                    sb.AppendLine("--- stderr ---");
                    sb.AppendLine(se);
                    if (exited)
                    {
                        try { sb.AppendLine("退出码: " + p.ExitCode); } catch { }
                    }
                    return sb.ToString();
                }
                catch (Exception ex)
                {
                    sb.AppendLine("用 " + exe + " 启动失败：" + ex.Message);
                }
            }

            sb.AppendLine("没找到可用的 node（runtime\\node.exe 与 PATH 都没有），doctor 跳过。");
            return sb.ToString();
        }

        /// <summary>读 JSON 并递归脱敏，写回格式化文本；文件不存在返回 null。</summary>
        private static string RedactedJson(string file, List<string> skipped)
        {
            if (!File.Exists(file)) return null;
            var text = ReadShared(file, skipped);
            if (string.IsNullOrWhiteSpace(text)) return null;
            try
            {
                var node = JsonNode.Parse(text);
                if (node == null) return null;
                RedactNode(node);
                return node.ToJsonString(new JsonSerializerOptions
                {
                    WriteIndented = true,
                    Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
                }) + Environment.NewLine;
            }
            catch (Exception ex)
            {
                skipped.Add(Path.GetFileName(file) + "（脱敏失败）：" + ex.Message);
                return null;
            }
        }

        /// <summary>递归把敏感键的值换成 "***"。对象/数组继续往下走，结构不动。</summary>
        private static void RedactNode(JsonNode node)
        {
            if (node is JsonObject obj)
            {
                foreach (var kv in obj.ToList())
                {
                    if (SecretKey.IsMatch(kv.Key))
                    {
                        if (kv.Value is JsonObject || kv.Value is JsonArray) RedactNode(kv.Value);
                        else obj[kv.Key] = "***";
                    }
                    else if (kv.Value != null)
                    {
                        RedactNode(kv.Value);
                    }
                }
            }
            else if (node is JsonArray arr)
            {
                foreach (var item in arr)
                    if (item != null) RedactNode(item);
            }
        }

        private (string Level, string FileLevel) ReadLogLevels()
        {
            var level = "info";
            var fileLevel = "";
            try
            {
                var file = Path.Combine(_sup.BaseDir, "config.json");
                if (!File.Exists(file)) return (level, fileLevel);
                using var doc = JsonDocument.Parse(File.ReadAllText(file));
                if (doc.RootElement.TryGetProperty("log", out var log) && log.ValueKind == JsonValueKind.Object)
                {
                    if (log.TryGetProperty("level", out var lv) && lv.ValueKind == JsonValueKind.String)
                        level = lv.GetString() ?? level;
                    if (log.TryGetProperty("fileLevel", out var fl) && fl.ValueKind == JsonValueKind.String)
                        fileLevel = fl.GetString() ?? "";
                }
            }
            catch { }
            return (level, fileLevel);
        }

        private (string Provider, string Model, string Vision) ReadModelInfo()
        {
            var provider = "";
            var model = "";
            var vision = "";
            try
            {
                // 面板设置（data/settings.json）优先：换服务商 / 模型都存在这里，
                // 只看 config.json 会写出「界面上明明换过了、日志包里还是旧模型」。
                var settingsFile = Path.Combine(_sup.DataDir, "settings.json");
                if (File.Exists(settingsFile))
                {
                    using var sdoc = JsonDocument.Parse(File.ReadAllText(settingsFile));
                    var sroot = sdoc.RootElement;
                    provider = JsonStr(sroot, "provider");
                    model = JsonStr(sroot, "model");
                    vision = JsonStr(sroot, "visionModel");
                }
                var file = Path.Combine(_sup.BaseDir, "config.json");
                if (!File.Exists(file))
                {
                    if (vision.Length == 0) vision = "glm-4.6v-flash";
                    return (provider, model, vision);
                }
                using var doc = JsonDocument.Parse(File.ReadAllText(file));
                var root = doc.RootElement;
                if (provider.Length == 0) provider = JsonStr(root, "provider");
                if (model.Length == 0 && provider.Length > 0 && root.TryGetProperty(provider, out var sec))
                    model = JsonStr(sec, "model");
                if (model.Length == 0) model = JsonStr(JsonProp(root, "chat"), "model");
                if (vision.Length == 0) vision = JsonStr(JsonProp(root, "vision"), "model");
                if (vision.Length == 0) vision = "glm-4.6v-flash";
            }
            catch { }
            return (provider, model, vision);
        }

        private static JsonElement JsonProp(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v : default;

        private static string JsonStr(JsonElement e, string name)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return "";
            return v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";
        }
    }
}
