using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace WhaleLauncher.Views
{
    public sealed class RecentItem
    {
        public string Time { get; set; }
        public string Who { get; set; }
        public string Text { get; set; }
    }

    public partial class StatusPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly HttpClient _http = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromSeconds(3)
        };

        private DateTime _lastCare = DateTime.MinValue;
        private DateTime _lastRecent = DateTime.MinValue;
        private RuntimeSupervisor.CareState _care;

        public StatusPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            Loaded += async (_, __) => await RefreshAsync();
        }

        public async Task RefreshAsync()
        {
            var s = await _sup.ProbeAsync();
            Apply(s);

            if ((DateTime.Now - _lastCare).TotalSeconds >= 30)
            {
                _lastCare = DateTime.Now;
                await RefreshCareAsync(s);
            }
            if ((DateTime.Now - _lastRecent).TotalSeconds >= 5)
            {
                _lastRecent = DateTime.Now;
                await RefreshRecentAsync(s);
            }
        }

        private void Apply(Snapshot s)
        {
            // 内核
            DotNode.Fill = s.NodeUp ? (Brush)FindResource("Ok") : (Brush)FindResource("Idle");
            NodeMain.Text = s.NodeUp ? "运行中" : "未启动";
            NodeAge.Text = s.NodeUp ? "已跑 " + Short(s.UptimeSec) : "";
            NodeSub.Text = s.NodeUp
                ? $"端口 {s.Port} · {s.Provider}/{s.Model}{(s.HasKey ? "" : " · 还没有 Key")}{(s.Mock ? " · 演示模式" : "")}"
                : "点顶栏 ⏻ 启动";

            // 桥接
            DotBridge.Fill = s.BrOnline ? (Brush)FindResource("Ok")
                : (s.NodeUp ? (Brush)FindResource("Warn") : (Brush)FindResource("Idle"));
            BridgeMain.Text = s.BrOnline ? "在线" : (s.NodeUp ? "离线" : "未启动");
            BridgeAge.Text = s.BrOnline && s.BrLastSeenSec >= 0 ? $"心跳 {s.BrLastSeenSec} 秒前" : "";
            BridgeSub.Text = s.BrOnline
                ? (s.BrUia ? "UIA 正常" : "UIA 拿不到") + (s.BrListener ? " · 收消息正常" : " · 收消息停了")
                : (s.NodeUp ? "内核在跑，桥接没连上" : "—");

            // 微信
            var who = !string.IsNullOrEmpty(s.BrAccountNick) ? s.BrAccountNick : s.BrAccount;
            DotWechat.Fill = s.BrOnline && s.BrAccountOk ? (Brush)FindResource("Ok")
                : (s.BrOnline ? (Brush)FindResource("Warn") : (Brush)FindResource("Idle"));
            WechatMain.Text = string.IsNullOrEmpty(who) ? "未知" : who;
            WechatSub.Text = s.BrOnline
                ? $"窗口 {(string.IsNullOrEmpty(s.BrWindow) ? "未知" : s.BrWindow)} · 账号{(s.BrAccountOk ? "已确认" : "未确认")} · 双开守卫{(s.BrAccountGuard ? "已开" : "已关")}"
                : "—";

            // 用量
            UsageLine.Text = s.NodeUp
                ? $"本次运行   收到 {s.StReceived}   ·   回复 {s.StReplied}   ·   发送 {s.StSent}   ·   失败 {s.StFailed}"
                : "本次运行   内核没起，还没有数";
            if (s.StFailed > 0) UsageLine.Foreground = (Brush)FindResource("Warn");
            else UsageLine.Foreground = (Brush)FindResource("Text");
        }

        private async Task RefreshCareAsync(Snapshot s)
        {
            if (!s.NodeUp)
            {
                CareLine.Text = "主动搭话   —";
                return;
            }
            try
            {
                _care = _sup.ReadCareState();
                await _sup.QueryCareDueAsync(_care);
                if (_care.Reason == "disabled") CareLine.Text = "主动搭话   已关闭";
                else if (_care.Due) CareLine.Text = $"主动搭话   今天 {_care.SentToday} 次 · 现在就该来一句了";
                else if (_care.WaitMinutes > 0) CareLine.Text = $"主动搭话   今天 {_care.SentToday} 次 · 下次约 {_care.WaitMinutes} 分后";
                else CareLine.Text = $"主动搭话   今天 {_care.SentToday} 次 · {ReasonText(_care.Reason)}";
            }
            catch
            {
                CareLine.Text = "主动搭话   —";
            }
        }

        private static string ReasonText(string r) => r switch
        {
            "out_of_window" => "现在不在时间窗里",
            "daily_cap" => "今天已经到上限了",
            "too_soon" => "刚说过没多久",
            "group_not_allowed" => "群里不让主动说话",
            "only_master" => "只对主人主动",
            _ => "等待中"
        };

        private async Task RefreshRecentAsync(Snapshot s)
        {
            if (!s.NodeUp)
            {
                Recent.ItemsSource = null;
                RecentEmpty.Visibility = Visibility.Visible;
                RecentEmpty.Text = "内核没起，看不到消息。";
                RecentHint.Text = "";
                return;
            }
            try
            {
                var json = await _http.GetStringAsync(_sup.Url + "/api/recent?limit=10");
                using var doc = JsonDocument.Parse(json);
                var items = new List<RecentItem>();
                if (doc.RootElement.TryGetProperty("items", out var arr) && arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var it in arr.EnumerateArray())
                    {
                        var ts = it.TryGetProperty("ts", out var t) && t.ValueKind == JsonValueKind.Number ? t.GetInt64() : 0;
                        items.Add(new RecentItem
                        {
                            Time = ts > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(ts).LocalDateTime.ToString("HH:mm") : "",
                            Who = Get(it, "who"),
                            Text = Get(it, "text")
                        });
                    }
                }
                Recent.ItemsSource = items;
                RecentEmpty.Visibility = items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
                if (items.Count == 0) RecentEmpty.Text = "还没有消息。先在微信里跟她说一句。";
                RecentHint.Text = items.Count > 0 ? items.Count + " 条" : "";
            }
            catch
            {
                // /api/recent 还没做，或者内核刚起
                Recent.ItemsSource = null;
                RecentEmpty.Visibility = Visibility.Visible;
                RecentEmpty.Text = "最近动态还会在下一轮接上（/api/recent 未就绪）。";
                RecentHint.Text = "";
            }
        }

        private static string Get(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

        private static string Short(long sec)
        {
            if (sec <= 0) return "0 秒";
            var t = TimeSpan.FromSeconds(sec);
            if (t.TotalHours >= 1) return $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}";
            if (t.TotalMinutes >= 1) return $"{t.Minutes} 分";
            return $"{t.Seconds} 秒";
        }

        // ── 动作 ────────────────────────────────────────────────
        private async void OnRefresh(object sender, RoutedEventArgs e)
        {
            _lastRecent = DateTime.MinValue;
            _lastCare = DateTime.MinValue;
            await RefreshAsync();
        }

        private async void OnRestartBridge(object sender, RoutedEventArgs e)
        {
            _sup.Say("— 从状态页重启桥接 —");
            _sup.RestartBridge();
            await Task.Delay(500);
            await RefreshAsync();
        }

        private void OnOpenData(object sender, RoutedEventArgs e) => Open(Path.Combine(AppContext.BaseDirectory, "data"));

        private void OnOpenConsole(object sender, RoutedEventArgs e) => Open(_sup.Url);

        private void Open(string target)
        {
            try
            {
                if (Directory.Exists(target) || target.StartsWith("http")) { /* 目录和网址直接开 */ }
                else Directory.CreateDirectory(target);
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                _sup.Say("打开失败：" + ex.Message);
            }
        }

        private void OnExportDiag(object sender, RoutedEventArgs e)
        {
            try
            {
                var data = Path.Combine(AppContext.BaseDirectory, "data");
                Directory.CreateDirectory(data);
                var name = "diag-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".zip";
                var path = Path.Combine(data, name);

                var sb = new StringBuilder();
                sb.AppendLine("鲸鲸 4.0 诊断包");
                sb.AppendLine("导出时间: " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
                sb.AppendLine("安装目录: " + AppContext.BaseDirectory);
                sb.AppendLine("内核运行: " + _sup.NodeRunning);
                sb.AppendLine("桥接运行: " + _sup.BridgeRunning);
                sb.AppendLine("端口: " + _sup.Port);
                sb.AppendLine("说明: 不含 config.json（里面有 Key），需要的话请手工脱敏后再附上。");

                using (var zip = ZipFile.Open(path, ZipArchiveMode.Create))
                {
                    void AddText(string entry, string content)
                    {
                        var e2 = zip.CreateEntry(entry, CompressionLevel.Optimal);
                        using var w = new StreamWriter(e2.Open(), new UTF8Encoding(false));
                        w.Write(content);
                    }
                    AddText("info.txt", sb.ToString());
                    foreach (var f in new[] { "launcher.log", "bridge.log", "kernel.log" })
                    {
                        var p = Path.Combine(data, f);
                        if (!File.Exists(p)) continue;
                        var lines = File.ReadAllLines(p);
                        var tail = lines.Length > 800 ? lines[^800..] : lines;
                        AddText(f, string.Join(Environment.NewLine, tail));
                    }
                }
                _sup.Say("诊断包已导出：" + path);
                Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                _sup.Say("导出诊断包失败：" + ex.Message);
            }
        }
    }
}
