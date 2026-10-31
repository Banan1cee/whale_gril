using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace WhaleLauncher.Views
{
    public sealed class ConsoleRow
    {
        public string TimeText { get; set; }
        public string LevelChar { get; set; }
        public string Src { get; set; }
        public string Text { get; set; }
    }

    public sealed class AccountCard
    {
        public string Title { get; set; }
        public string Sub { get; set; }
    }

    public partial class BridgePage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly HttpClient _http = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromSeconds(4)
        };

        private const int ViewCap = 3000;
        private readonly List<ConsoleRow> _all = new List<ConsoleRow>(ViewCap + 200);
        private readonly ObservableCollection<ConsoleRow> _view = new ObservableCollection<ConsoleRow>();
        private readonly List<ConsoleRow> _pending = new List<ConsoleRow>();
        private readonly object _pendingLock = new object();
        private readonly DispatcherTimer _drain;

        private bool _paused;
        private bool _loading;
        private bool _configLoaded;
        private DateTime _lastRefresh = DateTime.MinValue;

        public BridgePage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            Console.ItemsSource = _view;

            var hist = _sup.History(ViewCap);
            foreach (var line in hist)
                if (line.Src != "K" && !string.IsNullOrWhiteSpace(line.Text)) _all.Add(Wrap(line));
            _sup.Say($"桥接页初始化：历史 {hist.Count} 行，装进控制台 {_all.Count} 行");

            Rebuild();
            _sup.Line += OnLine;

            _drain = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(200) };
            _drain.Tick += (_, __) => Drain();
            _drain.Start();

            Unloaded += (_, __) => { _sup.Line -= OnLine; _drain.Stop(); };   // 页面不在了就停表，别空转（L16）
            Loaded += async (_, __) =>
            {
                _sup.Line -= OnLine;
                _sup.Line += OnLine;
                if (!_drain.IsEnabled) _drain.Start();
                await LoadConfigAsync();
                await RefreshAsync();
            };
        }

        private static ConsoleRow Wrap(LogLine l) => new ConsoleRow
        {
            TimeText = l.At.ToString("HH:mm:ss"),
            LevelChar = l.Level.ToString(),
            Src = l.Src,
            Text = l.Text
        };

        private void OnLine(LogLine line)
        {
            if (line.Src == "K") return;   // 内核日志在诊断页
            if (string.IsNullOrWhiteSpace(line.Text)) return;
            lock (_pendingLock) _pending.Add(Wrap(line));
        }

        private void Drain()
        {
            List<ConsoleRow> batch;
            lock (_pendingLock)
            {
                if (_pending.Count == 0) return;
                batch = new List<ConsoleRow>(_pending);
                _pending.Clear();
            }

            foreach (var row in batch)
            {
                _all.Add(row);
                if (_all.Count > ViewCap) _all.RemoveRange(0, _all.Count - ViewCap);
            }

            var pass = batch.Where(Pass).ToList();
            if (pass.Count > 0 && !_paused)
            {
                foreach (var row in pass) _view.Add(row);
                TrimView();
                if (ChkFollow.IsChecked == true) ScrollToEnd();
            }
            UpdateStat();
        }

        private bool Pass(ConsoleRow r)
        {
            if (ChkErrors.IsChecked == true && r.LevelChar == "i") return false;
            var q = (TxtSearch.Text ?? "").Trim();
            if (q.Length > 0 &&
                r.Text.IndexOf(q, StringComparison.OrdinalIgnoreCase) < 0 &&
                r.Src.IndexOf(q, StringComparison.OrdinalIgnoreCase) < 0) return false;
            return true;
        }

        private void Rebuild()
        {
            _view.Clear();
            foreach (var r in _all)
            {
                if (!Pass(r)) continue;
                _view.Add(r);
            }
            TrimView();
            if (ChkFollow.IsChecked == true) ScrollToEnd();
            UpdateStat();
        }

        private void TrimView()
        {
            while (_view.Count > ViewCap) _view.RemoveAt(0);
        }

        private void ScrollToEnd()
        {
            if (_view.Count == 0) return;
            try { Console.ScrollIntoView(_view[_view.Count - 1]); } catch { }
        }

        private void UpdateStat()
        {
            string conn;
            if (_sup.BridgeRunning) conn = "已连接";
            else if (_sup.NodeRunning) conn = "桥接已断开";
            else conn = "内核未启动";

            var errs = _all.Count(r => r.LevelChar == "e");
            ConsoleStat.Text = $"共 {_view.Count} 行 · 缓冲 {_all.Count}/{ViewCap} · {conn} · 错误 {errs} 条" +
                               (_paused ? " · 已暂停" : "");
        }

        // ── 控制台工具条 ────────────────────────────────────────
        private void OnConsoleOption(object sender, RoutedEventArgs e) => Rebuild();

        private void OnSearchChanged(object sender, TextChangedEventArgs e) => Rebuild();

        private void OnPause(object sender, RoutedEventArgs e)
        {
            _paused = !_paused;
            BtnPause.Content = _paused ? "继续" : "暂停";
            if (!_paused) Rebuild();
            else UpdateStat();
        }

        private void OnClear(object sender, RoutedEventArgs e)
        {
            _view.Clear();
            UpdateStat();
        }

        private void OnCopy(object sender, RoutedEventArgs e)
        {
            var sb = new StringBuilder();
            foreach (var r in _view) sb.AppendLine($"{r.TimeText} {r.LevelChar} {r.Src} {r.Text}");
            try
            {
                Clipboard.SetText(sb.ToString());
                ConsoleStat.Text = $"已复制 {_view.Count} 行到剪贴板";
            }
            catch (Exception ex)
            {
                ConsoleStat.Text = "复制失败：" + ex.Message;
            }
        }

        private void OnOpenBridgeLog(object sender, RoutedEventArgs e)
        {
            var path = Path.Combine(AppContext.BaseDirectory, "data", "bridge.log");
            try
            {
                if (File.Exists(path)) Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
                else Process.Start(new ProcessStartInfo(Path.GetDirectoryName(path)) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                ConsoleStat.Text = "打开日志失败：" + ex.Message;
            }
        }

        // ── 上半：账号 / 开关 / 权限 ────────────────────────────
        public async Task RefreshAsync()
        {
            if ((DateTime.Now - _lastRefresh).TotalMilliseconds < 800) return;
            _lastRefresh = DateTime.Now;

            var s = await _sup.ProbeAsync();
            UpdatePerm(s);
            if (!_configLoaded && s.NodeUp) await LoadConfigAsync();
            if ((DateTime.Now - _lastAccounts).TotalSeconds < 15) return;
            _lastAccounts = DateTime.Now;
            await LoadAccountsAsync(s);
        }

        private DateTime _lastAccounts = DateTime.MinValue;

        private void UpdatePerm(Snapshot s)
        {
            if (!s.NodeUp)
            {
                PermLine.Text = "内核没起，读不到权限信息。";
                return;
            }
            var sb = new StringBuilder();
            sb.Append(s.BrOnline ? "桥接在线" : "桥接离线");
            if (s.BrLastSeenSec >= 0) sb.Append($"（心跳 {s.BrLastSeenSec} 秒前）");
            sb.Append("   ·   窗口 ").Append(string.IsNullOrEmpty(s.BrWindow) ? "未知（心跳暂未上报）" : s.BrWindow);
            sb.Append("   ·   UIA ").Append(s.BrUia ? "正常" : "拿不到");
            sb.Append("   ·   收消息 ").Append(s.BrListener ? "正常" : "停了");
            sb.Append("   ·   双开守卫 ").Append(s.BrAccountGuard ? "开" : "关");
            if (!string.IsNullOrEmpty(s.BrAccountWhy)) sb.Append("\n").Append(s.BrAccountWhy);
            PermLine.Text = sb.ToString();
            UpdateStat();
        }

        private async Task LoadAccountsAsync(Snapshot s)
        {
            var cards = new List<AccountCard>();
            try
            {
                var json = await _http.GetStringAsync(_sup.Url + "/api/wechat/accounts");
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.TryGetProperty("accounts", out var arr) && arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var a in arr.EnumerateArray())
                    {
                        var account = Str(a, "account");
                        var nick = Str(a, "nick");
                        var active = a.TryGetProperty("active", out var ac) && ac.ValueKind == JsonValueKind.True;
                        cards.Add(new AccountCard
                        {
                            Title = (string.IsNullOrEmpty(nick) ? account : nick) + (active ? " · 当前在用" : ""),
                            Sub = string.IsNullOrEmpty(nick) ? account : account + (active ? "" : " · 未选中")
                        });
                    }
                }
            }
            catch { /* 内核没起或还没扫到账号 */ }

            if (cards.Count == 0 && s.BrOnline)
            {
                cards.Add(new AccountCard
                {
                    Title = string.IsNullOrEmpty(s.BrAccountNick) ? (string.IsNullOrEmpty(s.BrAccount) ? "微信" : s.BrAccount) : s.BrAccountNick,
                    Sub = (s.BrAccountOk ? "已确认" : "未确认") + (string.IsNullOrEmpty(s.BrAccountWhy) ? "" : " · " + s.BrAccountWhy)
                });
            }

            Accounts.ItemsSource = cards;
            AccountsEmpty.Visibility = cards.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        }

        private void OnRefreshAccounts(object sender, RoutedEventArgs e)
        {
            _lastAccounts = DateTime.MinValue;
            _ = RefreshAsync();
            _sup.Say("刷新微信账号列表");
        }

        private async void OnRestartBridge(object sender, RoutedEventArgs e) => await _sup.RestartBridgeAsync();

        // ── 配置读写 ────────────────────────────────────────────
        private async Task LoadConfigAsync()
        {
            if (_configLoaded) return;
            try
            {
                var json = await _http.GetStringAsync(_sup.Url + "/api/config");
                using var doc = JsonDocument.Parse(json);
                if (!doc.RootElement.TryGetProperty("config", out var cfg)) return;
                if (!cfg.TryGetProperty("wechat", out var wx) || wx.ValueKind != JsonValueKind.Object) return;

                _loading = true;
                ChkGuard.IsChecked = Bool(wx, "accountGuard");
                ChkQuote.IsChecked = Bool(wx, "quoteReply");

                var enabled = true;
                var fallback = true;
                if (wx.TryGetProperty("bgSend", out var bg) && bg.ValueKind == JsonValueKind.Object)
                {
                    enabled = Bool(bg, "enabled");
                    fallback = Bool(bg, "fallbackToForeground");
                }
                CmbSend.Items.Clear();
                CmbSend.Items.Add("自动：后台优先，失败回前台");
                CmbSend.Items.Add("仅前台：剪贴板粘贴");
                CmbSend.Items.Add("后台严格：不回退前台");
                CmbSend.SelectedIndex = !enabled ? 1 : (fallback ? 0 : 2);
                _configLoaded = true;
            }
            catch { /* 内核没起 */ }
            finally
            {
                _loading = false;
            }
        }

        private static bool Bool(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

        private static string Str(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

        private async Task PatchAsync(string json)
        {
            try
            {
                var body = new StringContent("{\"patch\":" + json + "}", Encoding.UTF8, "application/json");
                var res = await _http.PostAsync(_sup.Url + "/api/config", body);
                var text = await res.Content.ReadAsStringAsync();
                SwitchHint.Text = res.IsSuccessStatusCode ? "已保存，桥接会在几秒内用上新配置。" : "保存失败：" + text;
            }
            catch (Exception ex)
            {
                SwitchHint.Text = "保存失败：" + ex.Message;
            }
        }

        private async void OnToggleGuard(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            await PatchAsync("{\"wechat\":{\"accountGuard\":" + (ChkGuard.IsChecked == true ? "true" : "false") + "}}");
        }

        private async void OnToggleQuote(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            await PatchAsync("{\"wechat\":{\"quoteReply\":" + (ChkQuote.IsChecked == true ? "true" : "false") + "}}");
        }

        private async void OnSendModeChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_loading || CmbSend.SelectedIndex < 0) return;
            var idx = CmbSend.SelectedIndex;
            var enabled = idx != 1;
            var fallback = idx == 0;
            await PatchAsync("{\"wechat\":{\"bgSend\":{\"enabled\":" + (enabled ? "true" : "false") +
                             ",\"fallbackToForeground\":" + (fallback ? "true" : "false") + "}}}");
        }
    }
}
