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
using Microsoft.Win32;

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
            // 微信窗口现场：缩托盘 / 被自更新回收 / 双开钉错号，是「能心跳但发不出去」的头号原因
            var winOk = s.BrWindow == "可见" || s.BrWindow == "已最小化";
            AddCheck("微信窗口", winOk,
                string.IsNullOrEmpty(s.BrWindow) ? "桥接没上报窗口状态（桥接离线或版本较旧）" : s.BrWindow);
            AddCheck("微信账号", !s.BrOnline || s.BrAccountOk,
                string.IsNullOrEmpty(s.BrAccountNick) && s.BrAccountOk
                    ? "窗口已确认（桥接没上报昵称）"
                    : (string.IsNullOrEmpty(s.BrAccountWhy) ? s.BrAccountNick : s.BrAccountNick + "：" + s.BrAccountWhy));
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
        // 没有「时间范围」选项：点一下就是最常用的组合（当前这次 + 最近一次启动）

        private static readonly string[] LogFiles = { "launcher.log", "bridge.log", "kernel.log", "whale.log" };

        // 崩溃 / 卡死 / UIA 诊断 / 桥接自己的全量文件。
        // 「她突然不回了」的答案九成在这里，以前 info.txt 只报了大小、文件根本没进包。
        private static readonly string[] CrashLogFiles =
        {
            "crash.log", "bridge-crash.log", "bridge-hang.log", "bridge-boot.log",
            "uia-fault.log", "uia-selftest.log", "wechat-bridge-4x.log",
        };

        private static IEnumerable<string> AllLogFiles()
        {
            foreach (var f in LogFiles) yield return f;
            foreach (var f in CrashLogFiles) yield return f;
        }

        // 脱敏用：键名命中这些词的，值一律换成 "***"（结构保留）
        private static readonly Regex SecretKey =
            new Regex("apiKey|apikey|key|token|secret|password|cookie|session", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        // 这些不是「密钥」，但一样是隐私：主人的名字、她认的别名、忽略名单、
        // 主动搭话白名单、测试用的会话名。排查 bug 用不到这些字面值，但用户很在意。
        private static readonly Regex PrivacyKey =
            new Regex("^(ownerName|aliases|names|wxids|ignoreSenders|whitelist|testChat|chatTitle)$",
                RegexOptions.IgnoreCase | RegexOptions.Compiled);

        // 日志正文兜底：日志里没有做结构化脱敏（正文本来就可能带 Key 片段/微信号/手机号）
        private static readonly Regex SkKey = new Regex(@"\b(?:sk|oc_sk|ak|ghp|xox[baprs])[-_][A-Za-z0-9_\-]{8,}", RegexOptions.Compiled);
        private static readonly Regex Wxid = new Regex(@"\bwxid_[A-Za-z0-9_\-]{4,}", RegexOptions.Compiled);
        private static readonly Regex BearerToken = new Regex(@"(Bearer\s+)[A-Za-z0-9._\-]{12,}", RegexOptions.Compiled);
        private static readonly Regex PhoneNumber = new Regex(@"\b1[3-9]\d{9}\b", RegexOptions.Compiled);

        /// <summary>日志正文里能把人/Key 认出来的部分打码；其余原样保留，别破坏可读性。</summary>
        private static string MaskSecrets(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            try
            {
                var s = SkKey.Replace(text, "***key***");
                s = Wxid.Replace(s, "wxid_***");
                s = BearerToken.Replace(s, "$1***");
                s = PhoneNumber.Replace(s, "1**********");
                return s;
            }
            catch { return text; }
        }

        /// <summary>按 UTF-8 读出来一堆替换符 = 不是文本（GBK 老日志/二进制），那就原样拷贝。</summary>
        private static bool LooksBinary(string text)
        {
            if (string.IsNullOrEmpty(text)) return false;
            var bad = 0;
            foreach (var ch in text) if (ch == '\uFFFD') bad++;
            return bad > Math.Max(8, text.Length / 40);
        }

        private bool _exporting;

        /// <summary>
        /// 顶栏「导出日志」：点一下直接出包，不再问「要 10 分钟还是当次启动」。
        /// 报障时人只会点这一下，所以默认就应该把该看的一次性装进去：
        /// 当次启动 + 最近一次启动的日志、判定链、最近 30 分钟的原文、脱敏配置、doctor。
        /// </summary>
        private async void OnExport(object sender, RoutedEventArgs e)
        {
            await ExportAsync();
        }

        /// <summary>
        /// 导出流程：UI 线程只做 await，重活（读日志、跑 doctor、压 zip）都在后台线程，别把界面冻住。
        /// </summary>
        private async Task ExportAsync()
        {
            if (_exporting) return;
            _exporting = true;
            var oldText = BtnExport.Content;
            BtnExport.IsEnabled = false;
            BtnExport.Content = "导出中…";
            try
            {
                await LoadVersionsAsync();                       // node / python 版本，内部有缓存
                var probe = await _sup.ProbeAsync();             // 内核/桥接在线情况
                var status = await Api.Get(_sup.Url, "/api/status");
                var settings = await Api.Get(_sup.Url, "/api/settings");
                var doctor = await RunDoctorAsync();             // 15 秒超时，失败只写原因

                var path = await Task.Run(() => WritePackage(probe, status, settings, doctor));
                Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show("导出失败：" + ex.Message, "日志包");
            }
            finally
            {
                BtnExport.Content = oldText;
                BtnExport.IsEnabled = true;
                _exporting = false;
            }
        }

        /// <summary>在后台线程组装 zip。返回 zip 的绝对路径。</summary>
        private string WritePackage(Snapshot probe, ApiResult status, ApiResult settings, string doctor)
        {
            var name = "logs-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".zip";
            var path = Path.Combine(_sup.DataDir, name);
            Directory.CreateDirectory(_sup.DataDir);

            var skipped = new List<string>();

            // 先收集日志和配置（info.txt 里要写「哪些文件读失败了」，所以得排在 info.txt 之前）
            var logs = CollectLogs(skipped);
            var config = RedactedJson(Path.Combine(_sup.BaseDir, "config.json"), skipped);
            var settingsRedacted = RedactedJson(Path.Combine(_sup.DataDir, "settings.json"), skipped);
            var waFiles = WechatAutoLogs();
            var trace = CollectTrace(skipped);

            using (var zip = ZipFile.Open(path, ZipArchiveMode.Create))
            {
                AddText(zip, "README.txt", BuildReadme());
                AddText(zip, "info.txt", BuildInfo(probe, skipped));
                AddText(zip, "status.json", BuildStatus(status, settings));
                AddText(zip, "doctor.txt", doctor);
                if (config != null) AddText(zip, "config.redacted.json", config);
                if (settingsRedacted != null) AddText(zip, "settings.redacted.json", settingsRedacted);

                foreach (var (entry, text) in logs)
                    AddText(zip, entry, text);

                // 判定链 + 最近 30 分钟的原文：为什么回 / 为什么不回，全在这里
                foreach (var (entry, text) in trace)
                    AddText(zip, entry, text);

                // wechatauto 库自己的日志：最近两天的也带上，桥接层的错常在这里露出。
                // 改成读文本再打码（里面会带 wxid / 昵称），读不出文本才原样拷贝。
                foreach (var f in waFiles)
                {
                    try
                    {
                        var text = ReadShared(f, skipped);
                        if (!string.IsNullOrEmpty(text) && !LooksBinary(text))
                            AddText(zip, "wechatauto_logs/" + Path.GetFileName(f), MaskSecrets(text));
                        else
                            zip.CreateEntryFromFile(f, "wechatauto_logs/" + Path.GetFileName(f), CompressionLevel.Optimal);
                    }
                    catch (Exception ex) { skipped.Add(Path.GetFileName(f) + "：" + ex.Message); }
                }
            }

            return path;
        }

        // ── 日志收集 ────────────────────────────────────────────
        private List<(string Entry, string Text)> CollectLogs(List<string> skipped)
        {
            var result = new List<(string, string)>();

            // 当次启动：data/ 下这些文件就是当前这次（没在跑时它们就是最近一次）
            foreach (var f in AllLogFiles())
            {
                AddLog(result, "logs/current/" + f, Path.Combine(_sup.DataDir, f), skipped);
                AddLog(result, "logs/current/" + f + ".1", Path.Combine(_sup.DataDir, f + ".1"), skipped);
            }

            // 历史归档：崩溃重启过的话，真正的现场在 run-* 里；带上最近两份（连续崩两次也够用），
            // 每份只留尾部 1MB，包不至于失控。
            foreach (var run in RunDirs().Take(2))
            {
                foreach (var f in SafeFiles(run))
                    AddLog(result, "logs/" + Path.GetFileName(run) + "/" + Path.GetFileName(f), f, skipped, LogTailArchiveBytes);
            }

            return result;
        }

        // 日志是追加写的：开头基本都是启动横幅，尾部才是现场。当前这次留 3MB，历史归档留 1MB。
        private const int LogTailCurrentBytes = 3 * 1024 * 1024;
        private const int LogTailArchiveBytes = 1024 * 1024;

        private static void AddLog(List<(string, string)> target, string entry, string file, List<string> skipped,
                                   int tailBytes = LogTailCurrentBytes)
        {
            if (!File.Exists(file)) return;
            var text = ReadShared(file, skipped);
            if (string.IsNullOrEmpty(text)) return;
            if (text.Length > tailBytes)
            {
                var cut = text.Length - tailBytes;
                var nl = text.IndexOf('\n', cut);
                text = "…（只保留尾部 " + (tailBytes / 1024 / 1024) + "MB，前面省略）…\n"
                       + text.Substring(nl >= 0 ? nl + 1 : cut);
            }
            target.Add((entry, MaskSecrets(text)));
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

        // ── 判定链（trace）────────────────────────────────────
        /// <summary>
        /// data/trace 里的判定链 + 原文副本。
        /// 判定链全带（按天分的文件，一共也就几十 KB）；
        /// 原文只带最近 30 分钟、最多 60 条 —— 够复现「为什么回/不回」，又不把一堆聊天内容带出去。
        /// </summary>
        private List<(string Entry, string Text)> CollectTrace(List<string> skipped)
        {
            var result = new List<(string, string)>();
            var dir = Path.Combine(_sup.DataDir, "trace");
            if (!Directory.Exists(dir)) return result;

            foreach (var f in Directory.GetFiles(dir, "trace-*.jsonl").OrderByDescending(x => x))
            {
                var text = ReadShared(f, skipped);
                if (!string.IsNullOrEmpty(text)) result.Add(("trace/" + Path.GetFileName(f), text));
            }

            var rawDir = Path.Combine(dir, "raw");
            if (!Directory.Exists(rawDir)) return result;
            var since = DateTime.Now.AddMinutes(-30);
            foreach (var f in Directory.GetFiles(rawDir, "*.json")
                         .OrderByDescending(x => LastWriteOrMin(x))
                         .Where(x => LastWriteOrMin(x) >= since)
                         .Take(60))
            {
                var text = ReadShared(f, skipped);
                if (!string.IsNullOrEmpty(text)) result.Add(("trace/raw/" + Path.GetFileName(f), text));
            }
            return result;
        }

        private static DateTime LastWriteOrMin(string file)
        {
            try { return File.GetLastWriteTime(file); } catch { return DateTime.MinValue; }
        }

        private (int Lines, int Raw) TraceStats()
        {
            try
            {
                var dir = Path.Combine(_sup.DataDir, "trace");
                if (!Directory.Exists(dir)) return (0, 0);
                var lines = 0;
                foreach (var f in Directory.GetFiles(dir, "trace-*.jsonl"))
                {
                    try { lines += File.ReadLines(f).Count(l => l.Trim().Length > 0); } catch { }
                }
                var rawDir = Path.Combine(dir, "raw");
                var raw = Directory.Exists(rawDir) ? Directory.GetFiles(rawDir, "*.json").Length : 0;
                return (lines, raw);
            }
            catch { return (0, 0); }
        }
        // ── zip 内容 ────────────────────────────────────────────
        private static void AddText(ZipArchive zip, string entry, string content)
        {
            var item = zip.CreateEntry(entry, CompressionLevel.Optimal);
            using var w = new StreamWriter(item.Open(), new UTF8Encoding(false));   // UTF-8 无 BOM
            w.Write(content ?? "");
        }

        private static string BuildReadme()
        {
            var sb = new StringBuilder();
            sb.AppendLine("鲸鲸 · debug 日志包");
            sb.AppendLine("==================================================");
            sb.AppendLine("这是排查问题用的 debug 日志包，不是给日常使用的日志。");
            sb.AppendLine("包含范围：当次启动 + 最近两次启动的归档（当前这次留尾部 3MB，归档各留尾部 1MB）");
            sb.AppendLine();
            sb.AppendLine("包含内容：");
            sb.AppendLine("  README.txt            本文件");
            sb.AppendLine("  info.txt              运行环境、微信窗口/账号现场、消息统计、各项大小与磁盘剩余");
            sb.AppendLine("  config.redacted.json  config.json 的完整副本，敏感值已脱敏");
            sb.AppendLine("  settings.redacted.json data/settings.json 的副本，敏感值已脱敏");
            sb.AppendLine("  status.json           /api/status 与 /api/settings 的原始返回");
            sb.AppendLine("  doctor.txt            node server.js --doctor 的输出（尽力而为）");
            sb.AppendLine("  logs/                 各日志文件（logs/current/ 是这一次，logs/run-*/ 是历史启动）");
            sb.AppendLine("                        含 crash.log / bridge-crash.log / bridge-hang.log /");
            sb.AppendLine("                        bridge-boot.log / uia-*.log / wechat-bridge-4x.log");
            sb.AppendLine("  wechatauto_logs/      微信自动化库最近两天的日志");
            sb.AppendLine("  trace/                触发判定链 + 最近 30 分钟的消息原文（最多 60 条），见下面说明");
            sb.AppendLine();
            sb.AppendLine("关于脱敏：");
            sb.AppendLine("  ① 密钥类：键名匹配 apiKey / key / token / secret / password / cookie / session 的值换成 \"***\"；");
            sb.AppendLine("  ② 隐私类：主人的名字、别名、忽略名单、搭话白名单、测试会话名也换成 \"***\"；");
            sb.AppendLine("  ③ 日志正文：sk-xxx / wxid_xxx / Bearer token / 手机号会打码，其余原样保留。");
            sb.AppendLine("  配置结构、非敏感字段和模型名都原样保留，方便对齐配置。");
            sb.AppendLine();
            sb.AppendLine("关于 trace/：");
            sb.AppendLine("  判定链（为什么回 / 为什么不回）每行只写原因和规则名，不含聊天正文。");
            sb.AppendLine("  原文只带最近 30 分钟、最多 60 条：复现「为什么回/不回」够用，更早的聊天内容不进包。");
            sb.AppendLine();
            sb.AppendLine("遇到问题时，把整个 zip 原样发给对方即可，不用自己挑文件。");
            return sb.ToString();
        }

        private string BuildInfo(Snapshot probe, List<string> skipped)
        {
            var (level, fileLevel) = ReadLogLevels();
            var (provider, model, vision) = ReadModelInfo();
            if (provider.Length == 0) provider = probe?.Provider ?? "";
            if (model.Length == 0) model = probe?.Model ?? "";

            var sb = new StringBuilder();
            sb.AppendLine("鲸鲸 debug 日志包 · info");
            sb.AppendLine("==================================================");
            sb.AppendLine("导出时间        : " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "（时区 " + TimeZoneInfo.Local.Id + "）");
            sb.AppendLine("导出范围        : 当次启动 + 最近两次启动的归档（当前留尾部 3MB，归档各留 1MB）");
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
            sb.AppendLine("微信现场：");
            sb.AppendLine("  微信进程      : " + WechatProcessText());
            sb.AppendLine("  主窗状态      : " + (string.IsNullOrEmpty(probe?.BrWindow) ? "桥接没上报（老版本或离线）" : probe.BrWindow));
            sb.AppendLine("  当前账号      : " + AccountText(probe));
            sb.AppendLine("  UIA           : " + BoolText(probe?.BrUia) + "   收消息线程: " + BoolText(probe?.BrListener)
                          + "   ffmpeg: " + BoolText(probe?.BrFfmpeg) + "   账号闸: " + BoolText(probe?.BrAccountGuard));
            sb.AppendLine("  ffmpeg 位置   : " + FfmpegText());
            sb.AppendLine();
            sb.AppendLine("消息通道：");
            sb.AppendLine("  收到 " + (probe?.StReceived ?? 0) + " · 回复 " + (probe?.StReplied ?? 0)
                          + " · 发送 " + (probe?.StSent ?? 0) + " · 失败 " + (probe?.StFailed ?? 0));
            sb.AppendLine("  最后一条消息  : " + (probe != null && probe.StLastMessageAt > 0
                ? DateTimeOffset.FromUnixTimeMilliseconds(probe.StLastMessageAt).LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss") : "还没有"));
            sb.AppendLine("  最近一次失败  : " + (string.IsNullOrEmpty(probe?.StLastError) ? "无" : probe.StLastError));
            var (traceLines, traceRaw) = TraceStats();
            sb.AppendLine("  判定链        : " + traceLines + " 条（data/trace），原文副本 " + traceRaw + " 条"
                          + "（另含最近 30 分钟的原文，最多 60 条）");
            sb.AppendLine();
            sb.AppendLine("运行时：");
            sb.AppendLine("  runtime 清单  : " + ManifestText());
            sb.AppendLine("  Python 依赖   : " + PythonDepsText());
            sb.AppendLine();
            sb.AppendLine("各日志文件大小：");
            foreach (var f in AllLogFiles())
                sb.AppendLine("  data/" + f.PadRight(24) + SizeText(FileLen(Path.Combine(_sup.DataDir, f)))
                              + (FileLen(Path.Combine(_sup.DataDir, f + ".1")) > 0
                                  ? "（+.1 " + SizeText(FileLen(Path.Combine(_sup.DataDir, f + ".1"))) + "）" : ""));
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

        // ── info.txt 的现场信息（都能单独回答一个「为什么她不回」）─────
        private static string BoolText(bool? v) => v == null ? "未知" : (v == true ? "是" : "否");

        private static string AccountText(Snapshot s)
        {
            if (s == null) return "未知";
            var nick = string.IsNullOrEmpty(s.BrAccountNick) ? "（没上报昵称）" : s.BrAccountNick;
            var ok = s.BrAccountOk ? "窗口已确认" : "窗口未确认";
            var why = string.IsNullOrEmpty(s.BrAccountWhy) ? "" : "：" + s.BrAccountWhy;
            return nick + "（" + ok + why + "）";
        }

        private static string WechatProcessText()
        {
            try
            {
                var parts = new List<string>();
                foreach (var name in new[] { "Weixin", "WeChat" })
                {
                    var ps = Process.GetProcessesByName(name);
                    if (ps.Length == 0) continue;
                    parts.Add(name + " " + ps.Length + " 个（pid " + string.Join(",", ps.Take(3).Select(p => p.Id)) + "）");
                    foreach (var p in ps) p.Dispose();
                }
                return parts.Count > 0 ? string.Join(" / ", parts) : "没找到（Weixin.exe / WeChat.exe 都没有）";
            }
            catch (Exception ex) { return "读取失败：" + ex.Message; }
        }

        private string FfmpegText()
        {
            try
            {
                var bundled = Path.Combine(_sup.BaseDir, "runtime", "ffmpeg", "bin", "ffmpeg.exe");
                if (File.Exists(bundled)) return "包里自带（runtime\\ffmpeg\\bin\\ffmpeg.exe）";
                return "包里没有（微信 4.x 的 HEVC 图片转 jpg 要用它）";
            }
            catch { return "未知"; }
        }

        private string ManifestText()
        {
            try
            {
                var f = Path.Combine(_sup.BaseDir, "runtime", "manifest.json");
                if (!File.Exists(f)) return "没有 manifest.json（旧运行时目录）";
                var size = new FileInfo(f).Length;
                var at = File.GetLastWriteTime(f).ToString("yyyy-MM-dd HH:mm");
                return "有（" + size + " 字节，生成于 " + at + "）";
            }
            catch (Exception ex) { return "读取失败：" + ex.Message; }
        }

        private string PythonDepsText()
        {
            try
            {
                var sp = Path.Combine(_sup.BaseDir, "runtime", "python", "Lib", "site-packages");
                if (!Directory.Exists(sp)) return "没有 site-packages（运行时可能没装好）";
                var dirs = Directory.GetDirectories(sp);
                var key = new[] { "win32gui", "win32api", "uiautomation", "wechatauto" }
                    .Select(n => n + (Directory.Exists(Path.Combine(sp, n)) ? "✓" : "✗"));
                return dirs.Length + " 个包；关键依赖 " + string.Join(" ", key);
            }
            catch (Exception ex) { return "读取失败：" + ex.Message; }
        }

        private string LauncherVersion()        {
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
                    // 密钥类：整个值换掉；隐私类（人名/别名/名单）：数组逐项换，保留条数
                    if (SecretKey.IsMatch(kv.Key))
                    {
                        if (kv.Value is JsonObject || kv.Value is JsonArray) RedactNode(kv.Value);
                        else obj[kv.Key] = "***";
                    }
                    else if (PrivacyKey.IsMatch(kv.Key))
                    {
                        if (kv.Value is JsonArray arr)
                        {
                            for (var i = 0; i < arr.Count; i++)
                                if (arr[i] is JsonValue) arr[i] = "***";
                        }
                        else if (kv.Value is JsonValue) obj[kv.Key] = "***";
                        else if (kv.Value != null) RedactNode(kv.Value);
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


        // ── 数据维护：UIA 自检 / 备份记忆 / 恢复记忆 / 重置全部 ─────
        private sealed class SnapItem
        {
            public string Name = "";
            public string File = "";
            public DateTime At;
            public long Messages;
            public int Sessions;
            public override string ToString()
                => $"{At:yyyy-MM-dd HH:mm}   {Sessions} 个聊天 / {Messages} 条消息   {Name}";
        }

        private string NodeExe()
        {
            var local = Path.Combine(_sup.BaseDir, "runtime", "node", "node.exe");
            return File.Exists(local) ? local : "node";
        }

        private string PythonExe()
        {
            var local = Path.Combine(_sup.BaseDir, "runtime", "python", "python.exe");
            return File.Exists(local) ? local : "python";
        }

        private async Task<(int Code, string Output)> RunToolAsync(string exe, string args, int timeoutMs = 180000)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = exe,
                    Arguments = args,
                    WorkingDirectory = _sup.BaseDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                using var p = Process.Start(psi);
                var so = p.StandardOutput.ReadToEndAsync();
                var se = p.StandardError.ReadToEndAsync();
                var ok = await Task.Run(() => p.WaitForExit(timeoutMs));
                var text = (await so) + (await se);
                if (!ok)
                {
                    try { p.Kill(true); } catch { }
                    return (-1, text + "\n（超时，已中止）");
                }
                return (p.ExitCode, text);
            }
            catch (Exception ex)
            {
                return (-1, "启动失败：" + ex.Message);
            }
        }

        /// <summary>把一段长输出放进可滚动的只读窗口（不弹一屏 MessageBox）。</summary>
        private void ShowTextWindow(string title, string text)
        {
            var box = new TextBox
            {
                Text = string.IsNullOrEmpty(text) ? "（没有输出）" : text,
                IsReadOnly = true,
                BorderThickness = new Thickness(1),
                Padding = new Thickness(12),
                FontFamily = new FontFamily("Cascadia Mono, Consolas, monospace"),
                FontSize = 12,
                TextWrapping = TextWrapping.Wrap,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                VerticalContentAlignment = VerticalAlignment.Top,
                MinHeight = 320,
            };
            var win = new Window
            {
                Title = title,
                Width = 760,
                Height = 540,
                Owner = Window.GetWindow(this),
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Content = box,
            };
            // 全局 TextBox 样式给的是浅色字 + 深色底；新开窗口默认白底，会出现「白屏」，
            // 所以窗口背景和文字颜色都显式跟主题走。
            win.SetResourceReference(Window.BackgroundProperty, "Bg");
            box.SetResourceReference(Control.BackgroundProperty, "FieldBg");
            box.SetResourceReference(Control.ForegroundProperty, "Text");
            win.ShowDialog();
        }

        /// <summary>应用内确认弹窗：和界面同一套配色，替代系统 MessageBox。</summary>
        private bool AskInline(string title, string body, string okText, bool danger = false)
        {
            var win = new Window
            {
                Title = title,
                Width = 520,
                SizeToContent = SizeToContent.Height,
                ResizeMode = ResizeMode.NoResize,
                Owner = Window.GetWindow(this),
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                ShowInTaskbar = false,
            };
            win.SetResourceReference(Window.BackgroundProperty, "Bg");

            var panel = new StackPanel { Margin = new Thickness(22, 20, 22, 18) };

            var head = new TextBlock { Text = title, FontSize = 15, FontWeight = FontWeights.SemiBold };
            head.SetResourceReference(TextBlock.ForegroundProperty, "Text");
            panel.Children.Add(head);

            var text = new TextBlock
            {
                Text = body,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 10, 0, 0),
                LineHeight = 21,
            };
            text.SetResourceReference(TextBlock.ForegroundProperty, "Text2");
            panel.Children.Add(text);

            var row = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
                Margin = new Thickness(0, 18, 0, 0),
            };
            var cancel = new Button { Content = "取消", Style = (Style)FindResource("Primary"), Padding = new Thickness(16, 5, 16, 5) };
            var ok = new Button
            {
                Content = okText,
                Style = (Style)FindResource("Ghost"),
                Padding = new Thickness(16, 5, 16, 5),
                Margin = new Thickness(10, 0, 0, 0),
            };
            if (danger) ok.SetResourceReference(Control.ForegroundProperty, "Bad");
            row.Children.Add(cancel);
            row.Children.Add(ok);
            panel.Children.Add(row);

            var answered = false;
            cancel.Click += (s, e) => win.Close();
            ok.Click += (s, e) => { answered = true; win.Close(); };
            win.Content = panel;
            win.ShowDialog();
            return answered;
        }

        private async void OnUiaCheck(object sender, RoutedEventArgs e)
        {
            MaintenanceHint.Text = "正在检查微信 UIA 控件树（3~15 秒）…";
            try
            {
                var (code, output) = await RunToolAsync(PythonExe(), "\"" + Path.Combine(_sup.BaseDir, "scripts", "tools", "uia-check.py") + "\"", 60000);
                MaintenanceHint.Text = code == 0 ? "UIA 自检完成。" : "UIA 自检没通过，看窗口里的结论。";
                ShowTextWindow("UIA 自检", output);
            }
            finally
            {
                if (MaintenanceHint.Text.StartsWith("正在检查")) MaintenanceHint.Text = "";
            }
        }

        private async void OnBackupMemory(object sender, RoutedEventArgs e)
        {
            var dlg = new SaveFileDialog
            {
                Title = "备份记忆",
                FileName = "whale-memory-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".json",
                Filter = "鲸鲸记忆 (*.json)|*.json",
                InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            };
            if (dlg.ShowDialog() != true) return;

            MaintenanceHint.Text = "正在导出记忆…";
            var (code, output) = await RunToolAsync(NodeExe(), "\"scripts/memory-tool.js\" export \"" + dlg.FileName + "\"");
            if (code == 0)
            {
                MaintenanceHint.Text = "已备份到 " + dlg.FileName;
                MessageBox.Show(Window.GetWindow(this), "已备份到：\n" + dlg.FileName + "\n\n默认不含 API Key；要连 Key 一起带走请用命令行加 --secrets。",
                    "备份记忆", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            else
            {
                MaintenanceHint.Text = "备份失败";
                ShowTextWindow("备份失败", output);
            }
        }

        private async Task<List<SnapItem>> LoadSnapshotsAsync()
        {
            var list = new List<SnapItem>();
            var (code, output) = await RunToolAsync(NodeExe(), "\"scripts/memory-tool.js\" list --json");
            if (code != 0) return list;
            var start = output.IndexOf('[');
            var end = output.LastIndexOf(']');
            if (start < 0 || end <= start) return list;
            try
            {
                using var doc = JsonDocument.Parse(output.Substring(start, end - start + 1));
                foreach (var it in doc.RootElement.EnumerateArray())
                {
                    var at = DateTime.Now;
                    DateTime.TryParse(JsonStr(it, "mtime"), null, DateTimeStyles.RoundtripKind, out at);
                    list.Add(new SnapItem
                    {
                        Name = JsonStr(it, "name"),
                        File = JsonStr(it, "file"),
                        At = at,
                        Sessions = it.TryGetProperty("sessions", out var ss) && ss.ValueKind == JsonValueKind.Number ? ss.GetInt32() : 0,
                        Messages = it.TryGetProperty("messages", out var mm) && mm.ValueKind == JsonValueKind.Number ? mm.GetInt64() : 0,
                    });
                }
            }
            catch { }
            return list;
        }

        private async void OnRestoreMemory(object sender, RoutedEventArgs e)
        {
            MaintenanceHint.Text = "正在读取快照列表…";
            var snaps = await LoadSnapshotsAsync();
            MaintenanceHint.Text = snaps.Count == 0 ? "还没有自动快照，可以选外部备份文件恢复。" : "";

            var win = new Window
            {
                Title = "恢复记忆",
                Width = 640,
                Height = 440,
                Owner = Window.GetWindow(this),
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
            };
            var grid = new Grid { Margin = new Thickness(14) };
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            grid.Children.Add(new TextBlock
            {
                Text = "选一个快照恢复；恢复前会先停内核，并自动把当前记忆另存一份。",
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 8),
            });

            var listBox = new ListBox { ItemsSource = snaps, DisplayMemberPath = "" };
            Grid.SetRow(listBox, 1);
            grid.Children.Add(listBox);

            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 10, 0, 0) };
            var pick = new Button { Content = "从文件恢复…", Padding = new Thickness(12, 4, 12, 4) };
            var go = new Button { Content = "恢复选中", Padding = new Thickness(12, 4, 12, 4), Margin = new Thickness(8, 0, 0, 0), IsEnabled = snaps.Count > 0 };
            var cancel = new Button { Content = "取消", Padding = new Thickness(12, 4, 12, 4), Margin = new Thickness(8, 0, 0, 0) };
            buttons.Children.Add(pick);
            buttons.Children.Add(go);
            buttons.Children.Add(cancel);
            Grid.SetRow(buttons, 2);
            grid.Children.Add(buttons);
            win.Content = grid;

            string chosen = null;
            cancel.Click += (s, _) => win.Close();
            pick.Click += (s, _) =>
            {
                var dlg = new OpenFileDialog { Title = "选择记忆备份", Filter = "鲸鲸记忆 (*.json)|*.json" };
                if (dlg.ShowDialog() == true) { chosen = dlg.FileName; win.Close(); }
            };
            go.Click += (s, _) =>
            {
                if (listBox.SelectedItem is SnapItem item) { chosen = item.File; win.Close(); }
            };
            win.ShowDialog();

            if (string.IsNullOrEmpty(chosen)) return;

            var confirm = MessageBox.Show(
                Window.GetWindow(this),
                "要恢复这个备份吗？\n\n" + chosen + "\n\n" +
                "恢复前会先停止内核，并把当前记忆自动备份到 data\\backups\\。",
                "恢复记忆", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (confirm != MessageBoxResult.Yes) return;

            if (_sup.NodeRunning || _sup.BridgeRunning)
            {
                MaintenanceHint.Text = "正在停止内核…";
                _sup.StopAll();
                await Task.Delay(1200);
            }

            MaintenanceHint.Text = "正在恢复记忆…";
            var (code, output) = await RunToolAsync(NodeExe(), "\"scripts/memory-tool.js\" restore \"" + chosen + "\"", 300000);
            if (code != 0)
            {
                MaintenanceHint.Text = "恢复失败";
                ShowTextWindow("恢复失败", output);
                return;
            }

            MaintenanceHint.Text = "记忆已恢复";
            var restart = MessageBox.Show(Window.GetWindow(this), "恢复完成。\n\n现在重新启动内核和桥接吗？",
                "恢复记忆", MessageBoxButton.YesNo, MessageBoxImage.Question);
            if (restart == MessageBoxResult.Yes)
            {
                MaintenanceHint.Text = "正在启动…";
                await _sup.StartAllAsync();
                MaintenanceHint.Text = "已重新启动";
            }
        }

        private async void OnFactoryReset(object sender, RoutedEventArgs e)
        {
            if (!AskInline("重置全部（恢复出厂）",
                "会清空：聊天记忆、API Key、人设调教、主人名单、网关令牌、所有设置。\n" +
                "清空前会先自动备份到 backup\\reset-时间戳\\，但恢复要自己手动捞。",
                "继续")) return;

            if (!AskInline("最后确认",
                "真的要清空所有数据和设置吗？\n这一步不可撤销，只能从 backup\\reset-* 手动恢复。",
                "确定重置", danger: true)) return;

            MaintenanceHint.Text = "正在重置，别关窗口…";
            var (code, output) = await RunToolAsync("powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -File \"scripts/factory-reset.ps1\" -Yes -NoStart", 300000);
            if (code != 0)
            {
                MaintenanceHint.Text = "重置失败";
                ShowTextWindow("重置失败", output);
                return;
            }
            MaintenanceHint.Text = "已恢复出厂";
            MessageBox.Show(Window.GetWindow(this),
                "已恢复出厂设置。\n\n请关闭并重新打开启动器（数据目录已重建）。",
                "重置全部", MessageBoxButton.OK, MessageBoxImage.Information);
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