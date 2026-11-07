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
        /// <summary>要写进 wechat.account 的账号目录名；空串 = 不固定。</summary>
        public string Account { get; set; } = "";
        public string Nick { get; set; } = "";
        /// <summary>这台微信现在用的就是它（卡片高亮，再点没意义）。</summary>
        public bool IsActive { get; set; }
        /// <summary>能不能点。当前在用的卡 / 兜底信息卡都是 false。</summary>
        public bool CanPick { get; set; } = true;
        public string Tip { get; set; } = "";
    }

    public partial class BridgePage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly HttpClient _http = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromSeconds(4)
        };

        private const int ViewCap = 3000;
        // 后台通道打字的编码（写进 config.json 的 wechat.bgSend.charMode）。
        // 存的还是 auto/utf16/gbk 三个稳定值，界面上换成看得懂的说法：
        // 版本号认不出时用户得自己选，光写 auto/gbk 没人知道该选哪个。
        private static readonly string[] CharModeValues = { "auto", "utf16", "gbk" };
        private static readonly string[] CharModeLabels =
        {
            "自动（按微信版本）",
            "UTF-16（微信 4.2 及以上）",
            "GBK（微信 4.1 及以前）",
        };
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
            SmoothScroll.Attach(Console);
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
            SmoothScroll.End(Console);
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
            // 优先打开桥接自己写的全量日志（debug），bridge.log 只是启动器收到的 stdout 副本（info）
            var full = Path.Combine(AppContext.BaseDirectory, "data", "wechat-bridge-4x.log");
            var path = File.Exists(full) ? full : Path.Combine(AppContext.BaseDirectory, "data", "bridge.log");
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
            ConfigurationControls.SetReadOnly(this, !s.NodeUp);
            UpdatePerm(s);
            if (!_configLoaded) await LoadConfigAsync();
            if ((DateTime.Now - _lastAccounts).TotalSeconds < 15) return;
            _lastAccounts = DateTime.Now;
            await LoadAccountsAsync(s);
        }

        private DateTime _lastAccounts = DateTime.MinValue;
        private bool _autoScanTried;
        private bool _scanning;

        private void UpdatePerm(Snapshot s)
        {
            if (!s.NodeUp)
            {
                PermLine.Text = "内核没起，读不到权限信息。";
                PermLine.ToolTip = null;
                return;
            }
            var sb = new StringBuilder();
            sb.Append(s.BrOnline ? "桥接在线" : "桥接离线");
            if (s.BrLastSeenSec >= 0) sb.Append($"（心跳 {s.BrLastSeenSec} 秒前）");
            sb.Append("   ·   窗口 ").Append(string.IsNullOrEmpty(s.BrWindow) ? "未知（心跳暂未上报）" : s.BrWindow);
            sb.Append("   ·   UIA ").Append(s.BrUia ? "正常" : "拿不到");
            sb.Append("   ·   收消息 ").Append(s.BrListener ? "正常" : "停了");
            sb.Append("   ·   双开守卫 ").Append(s.BrAccountGuard ? "开" : "关");
            // 账号没确认的原因并进同一行（原来换行会被截断成两行）；放不下时悬停看全
            if (!string.IsNullOrEmpty(s.BrAccountWhy))
                sb.Append("   ·   ").Append(s.BrAccountWhy.Replace("\r", " ").Replace("\n", " "));
            PermLine.Text = sb.ToString();
            PermLine.ToolTip = sb.ToString();
            UpdateStat();
        }

        private async Task LoadAccountsAsync(Snapshot s)
        {
            var cards = new List<AccountCard>();
            var wanted = "";
            try
            {
                var json = await _http.GetStringAsync(_sup.Url + "/api/wechat/accounts");
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                wanted = Str(root, "wanted");
                if (root.TryGetProperty("accounts", out var arr) && arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var a in arr.EnumerateArray())
                    {
                        var account = Str(a, "account");
                        if (string.IsNullOrEmpty(account)) continue;
                        var nick = Str(a, "nick");
                        var active = a.TryGetProperty("active", out var ac) && ac.ValueKind == JsonValueKind.True;
                        var name = string.IsNullOrEmpty(nick) ? account : nick;
                        cards.Add(new AccountCard
                        {
                            Account = account,
                            Nick = nick,
                            IsActive = active,
                            CanPick = !active,
                            Title = name + (active ? "   ·   当前在用" : ""),
                            Sub = account + (active ? "" : "   ·   点此切换"),
                            Tip = active ? "这台微信现在用的就是它" : "点一下切到 " + name + "（桥接会自动重启）",
                        });
                    }
                }
            }
            catch { /* 内核没起或还没扫到账号 */ }

            // 第一次打开这一页、又还没有账号缓存（data/accounts.json）时自动扫一次：
            // 否则双开用户只能看到一张「当前在用」的兜底卡，找不到另一个号。
            if (cards.Count == 0 && s.BrOnline && !_autoScanTried)
            {
                _autoScanTried = true;
                _ = ScanAccountsAsync();
            }

            if (cards.Count == 0 && s.BrOnline)
            {
                cards.Add(new AccountCard
                {
                    Account = s.BrAccount,
                    Nick = s.BrAccountNick,
                    CanPick = false,
                    Title = string.IsNullOrEmpty(s.BrAccountNick) ? (string.IsNullOrEmpty(s.BrAccount) ? "微信" : s.BrAccount) : s.BrAccountNick,
                    Sub = (s.BrAccountOk ? "已确认" : "未确认") + (string.IsNullOrEmpty(s.BrAccountWhy) ? "" : " · " + s.BrAccountWhy),
                    Tip = "读不到账号目录，只能看桥接上报的这个号",
                });
            }

            Accounts.ItemsSource = cards;
            AccountsEmpty.Visibility = cards.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            AccountHint.Text = cards.Count == 0
                ? ""
                : (string.IsNullOrEmpty(wanted) ? "没固定账号 · 现在按最近活跃自动认" : "点一下卡片就切到这个号");
        }

        // ── 选账号：点卡片 = 把 wechat.account 钉成这个号（校验在内核做）──────
        private async void OnPickAccount(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            if (!(sender is FrameworkElement fe) || !(fe.DataContext is AccountCard card)) return;
            if (!card.CanPick)
            {
                SwitchHint.Text = "这个号已经在用了，不用再点。";
                return;
            }
            await PickAccountAsync(card.Account, string.IsNullOrEmpty(card.Nick) ? card.Account : card.Nick);
        }

        private async void OnUseAutoAccount(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            await PickAccountAsync("", "自动（按最近活跃）");
        }

        private async Task PickAccountAsync(string account, string label)
        {
            try
            {
                var body = new StringContent("{\"account\":\"" + Api.Esc(account) + "\"}", Encoding.UTF8, "application/json");
                var res = await _http.PostAsync(_sup.Url + "/api/wechat/account", body);
                var text = await res.Content.ReadAsStringAsync();
                if (!res.IsSuccessStatusCode)
                {
                    SwitchHint.Text = "切账号失败：" + ApiText(text);
                    return;
                }
                TxtAccount.Text = account;
                _sup.Say("微信账号 → " + label);
                // 别只指望桥接自己发现 config 变了：它的 config_watch 要等开库/预热
                // 做完才起得来，启动阶段切的号会被基线吞掉（现场：点了小号，回复
                // 还是从大号发出去）。这里直接重启，界面承诺的「几秒内重启」才作数。
                if (_sup.BridgeRunning) _sup.RestartBridge();
                SwitchHint.Text = "已切到 " + label + "，正在重启桥接…";
                _configLoaded = false;
                _lastAccounts = DateTime.MinValue;
                _lastRefresh = DateTime.MinValue;
                await Task.Delay(250);
                await RefreshAsync();
            }
            catch (Exception ex)
            {
                SwitchHint.Text = "切账号失败：" + ex.Message;
            }
        }

        /// <summary>后端报错是 {"error":"..."}，取出来给人看；不是 JSON 就原样给。</summary>
        private static string ApiText(string raw)
        {
            try
            {
                using var doc = JsonDocument.Parse(raw);
                if (doc.RootElement.ValueKind == JsonValueKind.Object
                    && doc.RootElement.TryGetProperty("error", out var er)
                    && er.ValueKind == JsonValueKind.String)
                    return er.GetString() ?? raw;
            }
            catch { }
            return string.IsNullOrWhiteSpace(raw) ? "内核没响应" : raw;
        }

        private void OnRefreshAccounts(object sender, RoutedEventArgs e)
        {
            _lastAccounts = DateTime.MinValue;
            _ = ScanAccountsAsync();
        }

        /// <summary>
        /// 真正让桥接扫一遍账号目录（开库读昵称，慢，最多 30 秒），再刷新界面。
        /// 以前这里只重新 GET 缓存，账号缓存没生成时点多少次都只有一张兜底卡。
        /// </summary>
        private async Task ScanAccountsAsync()
        {
            if (_scanning) return;
            _scanning = true;
            _sup.Say("刷新微信账号列表（开库读昵称，最多 30 秒）…");
            try
            {
                // 用独立的 HttpClient：页面这个 4 秒超时，扫描要十几秒
                using var scan = new HttpClient(new HttpClientHandler { UseProxy = false })
                {
                    Timeout = TimeSpan.FromSeconds(45)
                };
                using var res = await scan.PostAsync(
                    _sup.Url + "/api/wechat/accounts/refresh",
                    new StringContent("{}", Encoding.UTF8, "application/json"));
                var body = await res.Content.ReadAsStringAsync();
                if (!body.Contains("\"refreshed\":true"))
                    _sup.Say("扫描账号没成功：" + body);
            }
            catch (Exception ex)
            {
                _sup.Say("扫描账号失败：" + ex.Message);
            }
            finally
            {
                _scanning = false;
                _lastAccounts = DateTime.MinValue;
            }
            await RefreshAsync();
        }

        private void OnRestartBridge(object sender, RoutedEventArgs e) => _sup.RestartBridge();

        // ── 配置读写 ────────────────────────────────────────────
        private async Task LoadConfigAsync()
        {
            if (_configLoaded) return;
            try
            {
                var result = await _sup.ReadConfigurationAsync("/api/config");
                if (!result.Ok) return;
                var cfg = result.Prop("config");
                if (!cfg.TryGetProperty("wechat", out var wx) || wx.ValueKind != JsonValueKind.Object) return;

                _loading = true;
                ChkGuard.IsChecked = Bool(wx, "accountGuard");
                ChkQuote.IsChecked = Bool(wx, "quoteReply");

                var enabled = true;
                var fallback = true;
                var charMode = "auto";
                var charGap = 40;
                TxtAccount.Text = Str(wx, "account");
                if (wx.TryGetProperty("bgSend", out var bg) && bg.ValueKind == JsonValueKind.Object)
                {
                    enabled = Bool(bg, "enabled");
                    fallback = Bool(bg, "fallbackToForeground");
                    charMode = Str(bg, "charMode");
                    if (charMode.Length == 0) charMode = "auto";
                    charGap = Int(bg, "charGapMs", 40);
                    ChkUnhide.IsChecked = Bool(bg, "unhideWindow");
                    ChkVerify.IsChecked = Bool(bg, "verify");
                    ChkStrip.IsChecked = Bool(bg, "stripUnencodable");
                }
                if (!TxtCharGap.IsKeyboardFocusWithin) TxtCharGap.Text = charGap.ToString();
                CmbCharMode.Items.Clear();
                foreach (var label in CharModeLabels) CmbCharMode.Items.Add(label);
                var modeIndex = Array.IndexOf(CharModeValues, charMode);
                CmbCharMode.SelectedIndex = modeIndex >= 0 ? modeIndex : 0;
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

        private static int Int(JsonElement e, string name, int fallback)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : fallback;

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

        // ── 账号与发送（原「设置 → 微信 · 账号与发送」，归位到本页）────
        private async void OnSaveSendSettings(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            await SaveSendSettingsAsync();
        }

        private async void OnCharModeChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_loading) return;
            await SaveSendSettingsAsync();
        }

        private async Task SaveSendSettingsAsync()
        {
            var gap = 40;
            if (int.TryParse((TxtCharGap.Text ?? "").Trim(), out var g)) gap = Math.Clamp(g, 20, 80);
            else if ((TxtCharGap.Text ?? "").Trim().Length > 0) TxtCharGap.Text = gap.ToString();

            var mode = CharModeValues[Math.Max(0, Math.Min(CmbCharMode.SelectedIndex, CharModeValues.Length - 1))];
            await PatchAsync("{\"wechat\":{"
                + "\"account\":\"" + Api.Esc(TxtAccount.Text.Trim()) + "\","
                + "\"bgSend\":{\"charMode\":\"" + Api.Esc(mode) + "\",\"charGapMs\":" + gap + "}}}");
        }

        private async void OnSaveSendOpt(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            await PatchAsync("{\"wechat\":{\"bgSend\":{"
                + "\"unhideWindow\":" + (ChkUnhide.IsChecked == true ? "true" : "false") + ","
                + "\"verify\":" + (ChkVerify.IsChecked == true ? "true" : "false") + ","
                + "\"stripUnencodable\":" + (ChkStrip.IsChecked == true ? "true" : "false")
                + "}}}");
        }
    }
}
