using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace WhaleLauncher.Views
{
    /// <summary>提醒列表里的一行。</summary>
    public sealed class ReminderRow
    {
        public string Id { get; set; } = "";
        public string Time { get; set; } = "";
        public string Name { get; set; } = "";
        public string Wxid { get; set; } = "";
        public string Text { get; set; } = "";
        public string Status { get; set; } = "";
        public Brush StatusBrush { get; set; }
        public string Error { get; set; } = "";
        public Visibility ErrorVisibility => string.IsNullOrEmpty(Error) ? Visibility.Collapsed : Visibility.Visible;
    }

    /// <summary>提醒列表：只读展示 + 删除（取消）一条提醒。</summary>
    public partial class ReminderPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private DateTime _lastLoad = DateTime.MinValue;
        private bool _busy;

        public ReminderPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            Loaded += async (_, __) => await RefreshAsync();
        }

        public async Task RefreshAsync()
        {
            if (_busy) return;
            if ((DateTime.Now - _lastLoad).TotalSeconds < 3) return;
            _lastLoad = DateTime.Now;
            _busy = true;
            try
            {
                if (!_sup.NodeRunning)
                {
                    ShowState("内核没起，连不上提醒接口。点顶栏 ⏻ 启动。", true);
                    return;
                }

                var res = await Api.Get(_sup.Url, "/api/reminders");
                if (!res.Ok)
                {
                    ShowState("提醒接口还没就绪（GET /api/reminders 失败）。" + Detail(res), true);
                    return;
                }

                var rows = new List<ReminderRow>();
                var arr = res.Prop("items");
                if (arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var it in arr.EnumerateArray())
                    {
                        if (it.ValueKind != JsonValueKind.Object) continue;
                        var rawStatus = GetStr(it, "status");
                        var (statusText, brushKey) = StatusOf(rawStatus);
                        var wxid = GetStr(it, "wxid");
                        var name = GetStr(it, "name");
                        rows.Add(new ReminderRow
                        {
                            Id = GetStr(it, "id"),
                            Time = FormatDue(it),
                            Name = name.Length > 0 ? name : (wxid.Length > 0 ? wxid : "（未知目标）"),
                            Wxid = wxid,
                            Text = GetStr(it, "text"),
                            Status = statusText,
                            StatusBrush = (Brush)FindResource(brushKey),
                            Error = GetStr(it, "error")
                        });
                    }
                }

                ReminderList.ItemsSource = rows;
                if (rows.Count == 0)
                {
                    EmptyText.Text = "还没有提醒";
                    EmptyText.Foreground = (Brush)FindResource("Dim");
                    EmptyText.Visibility = Visibility.Visible;
                }
                else
                {
                    EmptyText.Visibility = Visibility.Collapsed;
                }
                LoadRules(res.Prop("rules"));
                await LoadCareAsync();
                StatusText.Text = "共 " + rows.Count + " 条 · " + DateTime.Now.ToString("HH:mm:ss") + " 刷新";
            }
            catch (Exception ex)
            {
                ShowState("刷新提醒失败：" + ex.Message, true);
            }
            finally
            {
                _busy = false;
            }
        }

        private async void OnRefresh(object sender, RoutedEventArgs e)
        {
            _lastLoad = DateTime.MinValue;
            await RefreshAsync();
        }

        private async void OnCancelReminder(object sender, RoutedEventArgs e)
        {
            if (!(sender is Button btn)) return;
            var id = btn.Tag as string;
            if (string.IsNullOrEmpty(id)) return;

            btn.IsEnabled = false;
            try
            {
                var res = await Api.Post(_sup.Url, "/api/reminders/cancel",
                    "{\"id\":\"" + Api.Esc(id) + "\"}");
                if (!res.Ok)
                {
                    StatusText.Text = "取消失败：" + (res.Error.Length > 0 ? res.Error : Detail(res));
                    return;
                }
                StatusText.Text = "已取消提醒 " + id;
                _lastLoad = DateTime.MinValue;
                await RefreshAsync();
            }
            finally
            {
                btn.IsEnabled = true;
            }
        }


        // ── 提醒规则（和主动搭话同语义，配置独立）──────────────
        // ── 主动搭话（同一页，配置独立）────────────────────────
        private async Task LoadCareAsync()
        {
            var cfg = await Api.Get(_sup.Url, "/api/config");
            if (!cfg.Ok || cfg.Prop("config").ValueKind != JsonValueKind.Object) return;
            if (!cfg.Prop("config").TryGetProperty("care", out var care) || care.ValueKind != JsonValueKind.Object)
                return;
            ChkCareEnabled.IsChecked = Flag(care, "enabled");
            ChkCareOnlyMaster.IsChecked = Flag(care, "onlyMaster");
            ChkCareGroups.IsChecked = Flag(care, "allowGroups");
            ChkCareOthers.IsChecked = Flag(care, "allowOthers");
            TxtCareEvery.Text = Num(care, "everyMinutes", 90);
            TxtCareJitter.Text = Num(care, "jitterMinutes", 25);
            TxtCareMax.Text = Num(care, "maxPerDay", 0);
            TxtCareQuiet.Text = Num(care, "quietAfterMinutes", 0);
            TxtCareWindows.Text = JoinLines(care, "windows");
            TxtCareWhitelist.Text = JoinLines(care, "whitelist");
            if (cfg.Prop("config").TryGetProperty("group", out var g) && g.ValueKind == JsonValueKind.Object)
                TxtCareMuted.Text = JoinLines(g, "mutedGroups");
            CareStatus.Text = "";
        }

        private async void OnSaveCare(object sender, RoutedEventArgs e)
        {
            if (!IntOr(TxtCareEvery.Text, 90, 5, 1440, out var every, "平均间隔")
                || !IntOr(TxtCareJitter.Text, 25, 0, 180, out var jitter, "间隔浮动")
                || !IntOr(TxtCareMax.Text, 0, 0, 50, out var max, "每天最多几次")
                || !IntOr(TxtCareQuiet.Text, 0, 0, 240, out var quiet, "刚聊过先跳过"))
                return;

            BtnSaveCare.IsEnabled = false;
            try
            {
                var json = "{\"patch\":{" +
                    "\"care.enabled\":" + (ChkCareEnabled.IsChecked == true ? "true" : "false") + "," +
                    "\"care.onlyMaster\":" + (ChkCareOnlyMaster.IsChecked == true ? "true" : "false") + "," +
                    "\"care.allowGroups\":" + (ChkCareGroups.IsChecked == true ? "true" : "false") + "," +
                    "\"care.allowOthers\":" + (ChkCareOthers.IsChecked == true ? "true" : "false") + "," +
                    "\"care.everyMinutes\":" + every + "," +
                    "\"care.jitterMinutes\":" + jitter + "," +
                    "\"care.maxPerDay\":" + max + "," +
                    "\"care.quietAfterMinutes\":" + quiet + "," +
                    "\"care.windows\":" + Lines(TxtCareWindows) + "," +
                    "\"care.whitelist\":" + Lines(TxtCareWhitelist) + "," +
                    "\"group.mutedGroups\":" + Lines(TxtCareMuted) +
                    "}}";
                var res = await Api.Post(_sup.Url, "/api/config", json);
                if (!res.Ok)
                {
                    CareStatus.Text = "保存失败：" + (res.Error.Length > 0 ? res.Error : Detail(res));
                    return;
                }
                CareStatus.Text = "已保存 " + DateTime.Now.ToString("HH:mm:ss");
            }
            finally
            {
                BtnSaveCare.IsEnabled = true;
            }
        }

        private bool IntOr(string raw, int fallback, int min, int max, out int value, string label)
        {
            var text = (raw ?? "").Trim();
            if (text.Length == 0) text = fallback.ToString();
            if (!int.TryParse(text, out value) || value < min || value > max)
            {
                CareStatus.Text = label + " 要填 " + min + "～" + max + " 的整数";
                return false;
            }
            return true;
        }

        private static bool Flag(JsonElement obj, string name)
            => obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

        private static string Num(JsonElement obj, string name, int fallback)
            => obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
                ? v.GetInt32().ToString() : fallback.ToString();

        private static string JoinLines(JsonElement obj, string name)
        {
            if (!obj.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Array) return "";
            return string.Join("\n", v.EnumerateArray()
                .Where(x => x.ValueKind == JsonValueKind.String)
                .Select(x => x.GetString() ?? "")
                .Where(x => x.Length > 0));
        }

        private static string Lines(System.Windows.Controls.TextBox box)
        {
            var items = (box.Text ?? "").Split('\n')
                .Select(x => x.Trim()).Where(x => x.Length > 0)
                .Select(x => "\"" + Api.Esc(x) + "\"");
            return "[" + string.Join(",", items) + "]";
        }

        private void LoadRules(JsonElement rules)
        {
            if (rules.ValueKind != JsonValueKind.Object) return;
            if (rules.TryGetProperty("enabled", out var en))
                ChkEnabled.IsChecked = en.ValueKind == JsonValueKind.True;
            if (rules.TryGetProperty("maxPerDay", out var cap) && cap.ValueKind == JsonValueKind.Number)
                TxtMaxPerDay.Text = cap.GetInt32().ToString();
            if (rules.TryGetProperty("quietAfterMinutes", out var quiet) && quiet.ValueKind == JsonValueKind.Number)
                TxtQuiet.Text = quiet.GetInt32().ToString();
            RulesStatus.Text = "";
        }

        private async void OnSaveRules(object sender, RoutedEventArgs e)
        {
            var maxText = (TxtMaxPerDay.Text ?? "").Trim();
            var quietText = (TxtQuiet.Text ?? "").Trim();
            if (!int.TryParse(maxText.Length == 0 ? "0" : maxText, out var maxPerDay) || maxPerDay < 0)
            {
                RulesStatus.Text = "每天次数要填 0 或正整数";
                return;
            }
            if (!int.TryParse(quietText.Length == 0 ? "0" : quietText, out var quiet) || quiet < 0)
            {
                RulesStatus.Text = "「刚聊过先跳过」要填 0 或正整数";
                return;
            }
            BtnSaveRules.IsEnabled = false;
            try
            {
                var json = "{\"patch\":{" +
                    "\"reminder.enabled\":" + (ChkEnabled.IsChecked == true ? "true" : "false") + "," +
                    "\"reminder.maxPerDay\":" + maxPerDay + "," +
                    "\"reminder.quietAfterMinutes\":" + quiet +
                    "}}";
                var res = await Api.Post(_sup.Url, "/api/config", json);
                if (!res.Ok)
                {
                    RulesStatus.Text = "保存失败：" + (res.Error.Length > 0 ? res.Error : Detail(res));
                    return;
                }
                RulesStatus.Text = "规则已保存 " + DateTime.Now.ToString("HH:mm:ss");
                _lastLoad = DateTime.MinValue;
                await RefreshAsync();
            }
            finally
            {
                BtnSaveRules.IsEnabled = true;
            }
        }

        private void ShowState(string text, bool error)
        {
            ReminderList.ItemsSource = null;
            EmptyText.Text = text ?? "";
            EmptyText.Foreground = error ? (Brush)FindResource("Bad") : (Brush)FindResource("Dim");
            EmptyText.Visibility = Visibility.Visible;
            StatusText.Text = error ? "刷新失败" : "";
        }

        // ── 字段读取 ────────────────────────────────────────────
        private static (string Text, string BrushKey) StatusOf(string raw) => raw switch
        {
            "pending" => ("待发", "Warn"),
            "retrying" => ("重试中", "Warn"),
            "done" => ("已发", "Ok"),
            "failed" => ("失败", "Bad"),
            "expired" => ("已过期", "Dim"),
            "cancelled" => ("已取消", "Dim"),
            _ => (string.IsNullOrEmpty(raw) ? "未知" : raw, "Muted")
        };

        private static string FormatDue(JsonElement it)
        {
            long ms = 0;
            if (it.TryGetProperty("dueAt", out var d))
            {
                if (d.ValueKind == JsonValueKind.Number)
                {
                    if (d.TryGetInt64(out var n)) ms = n;
                }
                else if (d.ValueKind == JsonValueKind.String && long.TryParse(d.GetString(), out var s))
                {
                    ms = s;
                }
            }
            if (ms <= 0) return "—";
            if (ms < 100000000000L) ms *= 1000;   // 后端如果给的是秒，兼容一下
            try { return DateTimeOffset.FromUnixTimeMilliseconds(ms).LocalDateTime.ToString("MM-dd HH:mm"); }
            catch { return "—"; }
        }

        private static string GetStr(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

        private static string Detail(ApiResult res)
        {
            var raw = (res?.Raw ?? "").Trim();
            if (raw.Length == 0) return res?.Error ?? "";
            raw = raw.Replace("\r", " ").Replace("\n", " ");
            return raw.Length > 120 ? raw.Substring(0, 120) + "…" : raw;
        }
    }
}
