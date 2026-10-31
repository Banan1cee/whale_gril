using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace WhaleLauncher.Views
{
    public sealed class PresetItem
    {
        public string Id { get; set; }
        public string Label { get; set; }
        public override string ToString() => Label ?? Id ?? "";
    }

    public partial class PersonaPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly DispatcherTimer _saveTimer;
        private bool _loading;
        private bool _loaded;

        public PersonaPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;

            foreach (var e in new[] { "关", "少", "正常", "多" }) CmbEmoji.Items.Add(e);

            _saveTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(450) };
            _saveTimer.Tick += async (_, __) =>
            {
                _saveTimer.Stop();
                await SaveAllAsync("已保存");
            };

            Loaded += async (_, __) => await RefreshAsync();
        }

        public async Task RefreshAsync()
        {
            if (!_sup.NodeRunning || _loaded) return;
            await LoadAsync();
        }

        private async Task LoadAsync()
        {
            var res = await Api.Get(_sup.Url, "/api/persona");
            if (!res.Ok) return;

            var set = await Api.Get(_sup.Url, "/api/settings");
            var cfg = await Api.Get(_sup.Url, "/api/config");

            _loading = true;
            try
            {
                var p = res.Prop("persona");
                if (p.ValueKind == JsonValueKind.Object)
                {
                    TxtName.Text = S(p, "name");
                    TxtAge.Text = L(p, "age").ToString();
                    TxtJob.Text = S(p, "job");
                    TxtLook.Text = S(p, "appearance");
                    TxtPerson.Text = S(p, "personality");
                    TxtBack.Text = S(p, "background");
                    TxtPrompt.Text = S(p, "customPrompt");

                    TxtPrivate.Text = L(p, "privateMaxChars").ToString();
                    TxtGroup.Text = L(p, "groupMaxChars").ToString();
                    TxtTurns.Text = L(p, "historyTurns").ToString();
                    TxtGroupTurns.Text = L(p, "groupHistoryTurns").ToString();
                    var emoji = S(p, "emoji");
                    CmbEmoji.SelectedItem = string.IsNullOrEmpty(emoji) ? "正常" : emoji;

                    ChkFreeChat.IsChecked = B(p, "freeChat");
                    ChkEmotions.IsChecked = B(p, "emotions");
                    ChkProactive.IsChecked = B(p, "proactive");
                    ChkOpinions.IsChecked = B(p, "opinions");
                    ChkLinks.IsChecked = B(p, "links");

                    var src = S(p, "sourcePreset");
                    CurrentPreset.Text = string.IsNullOrEmpty(src) ? "人设：手写/默认" : "人设：来自 " + src;
                }

                if (set.Ok) TxtOwner.Text = set.Str("userName");

                if (cfg.Ok && cfg.Prop("config").ValueKind == JsonValueKind.Object &&
                    cfg.Prop("config").TryGetProperty("group", out var g) && g.ValueKind == JsonValueKind.Object)
                    ChkRequireAt.IsChecked = B(g, "requireAt");
                if (cfg.Ok && cfg.Prop("config").ValueKind == JsonValueKind.Object &&
                    cfg.Prop("config").TryGetProperty("persona", out var pcfg) && pcfg.ValueKind == JsonValueKind.Object)
                {
                    TxtAliases.Text = JoinLines(pcfg, "aliases");
                    ChkRoast.IsChecked = B(pcfg, "masterRoast");
                    if (pcfg.TryGetProperty("master", out var m) && m.ValueKind == JsonValueKind.Object)
                    {
                        TxtMasterNames.Text = JoinLines(m, "names");
                        TxtMasterWxids.Text = JoinLines(m, "wxids");
                    }
                }

                UpdateHints();
            }
            finally { _loading = false; }

            await LoadPresetsAsync();
            await LoadFlagsAsync();
            _loaded = true;
            SaveState.Text = "";
        }

        private void UpdateHints()
        {
            HintPrivate.Text = "大约 " + Preview("嗯嗯，我知道啦，那今天先这样吧", TxtPrivate.Text) + " 个字一句话";
            HintGroup.Text = "群里短一些更像活人：" + Preview("在的在的", TxtGroup.Text) + " 个字";
        }

        private static string Preview(string sample, string limit)
        {
            if (!int.TryParse(limit, out var n) || n <= 0) return sample.Length.ToString();
            return Math.Max(1, Math.Min(n, sample.Length)).ToString();
        }

        private async Task LoadPresetsAsync()
        {
            var res = await Api.Get(_sup.Url, "/api/persona/presets");
            if (!res.Ok) return;
            var items = new List<PresetItem>();
            var arr = res.Prop("presets");
            if (arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var p in arr.EnumerateArray())
                {
                    var id = S(p, "id");
                    var name = S(p, "name");
                    var ver = S(p, "version");
                    items.Add(new PresetItem { Id = id, Label = string.IsNullOrEmpty(ver) ? $"{name}（{id}）" : $"{name} · {ver}" });
                }
            }
            CmbPreset.ItemsSource = items;
            if (items.Count > 0) CmbPreset.SelectedIndex = 0;
            else PresetResult.Text = "presets 目录里没有人设版本。";
        }

        private async Task LoadFlagsAsync()
        {
            FlagsHost.Children.Clear();
            var res = await Api.Get(_sup.Url, "/api/features");
            if (!res.Ok) return;
            var arr = res.Prop("features");
            if (arr.ValueKind != JsonValueKind.Array) return;

            foreach (var f in arr.EnumerateArray())
            {
                var key = S(f, "key");
                var label = S(f, "label");
                var desc = S(f, "desc");
                var on = B(f, "value");
                var def = B(f, "default");
                var exp = B(f, "experimental");

                var chk = new CheckBox
                {
                    Content = label + (exp ? "（实验性）" : "") + $"   默认：{(def ? "开" : "关")}",
                    IsChecked = on,
                    Margin = new Thickness(0, 8, 0, 0),
                    Tag = key
                };
                chk.Click += OnFlagClick;
                FlagsHost.Children.Add(chk);

                var d = new TextBlock
                {
                    Text = desc,
                    Style = (Style)FindResource("Small"),
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(20, 3, 0, 0)
                };
                FlagsHost.Children.Add(d);
            }
        }

        private async void OnFlagClick(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            if (!(sender is CheckBox chk) || chk.Tag is not string key) return;
            var value = chk.IsChecked == true;
            var res = await Api.Post(_sup.Url, "/api/features",
                $"{{\"key\":\"{Api.Esc(key)}\",\"value\":{(value ? "true" : "false")}}}");
            SaveState.Text = res.Ok ? $"开关 {key} → {(value ? "开" : "关")}" : "开关保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
        }

        // ── 保存 ────────────────────────────────────────────────
        private void OnFieldLostFocus(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            UpdateHints();
            _saveTimer.Stop();
            _saveTimer.Start();
        }

        private void OnToggleField(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            _saveTimer.Stop();
            _saveTimer.Start();
        }

        private void OnEmojiChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_loading) return;
            _saveTimer.Stop();
            _saveTimer.Start();
        }

        private async void OnSaveAll(object sender, RoutedEventArgs e) => await SaveAllAsync("已保存");

        private async void OnReload(object sender, RoutedEventArgs e)
        {
            _loaded = false;
            SaveState.Text = "重新读取…";
            await LoadAsync();
        }

        private async Task SaveAllAsync(string okText)
        {
            if (_loading || !_sup.NodeRunning) return;

            int age = int.TryParse(TxtAge.Text.Trim(), out var a) ? Math.Clamp(a, 1, 120) : 23;
            int priv = int.TryParse(TxtPrivate.Text.Trim(), out var pv) ? Math.Clamp(pv, 40, 800) : 140;
            int grp = int.TryParse(TxtGroup.Text.Trim(), out var gv) ? Math.Clamp(gv, 20, 300) : 70;
            int turns = int.TryParse(TxtTurns.Text.Trim(), out var tv) ? Math.Clamp(tv, 4, 400) : 200;
            int gturns = int.TryParse(TxtGroupTurns.Text.Trim(), out var gtv) ? Math.Clamp(gtv, 2, 300) : 150;

            var emoji = CmbEmoji.SelectedItem as string ?? "正常";

            var json = "{" +
                $"\"name\":\"{Api.Esc(TxtName.Text.Trim())}\"," +
                $"\"age\":{age}," +
                $"\"job\":\"{Api.Esc(TxtJob.Text.Trim())}\"," +
                $"\"appearance\":\"{Api.Esc(TxtLook.Text.Trim())}\"," +
                $"\"personality\":\"{Api.Esc(TxtPerson.Text.Trim())}\"," +
                $"\"background\":\"{Api.Esc(TxtBack.Text.Trim())}\"," +
                $"\"customPrompt\":\"{Api.Esc(TxtPrompt.Text.Trim())}\"," +
                $"\"privateMaxChars\":{priv}," +
                $"\"groupMaxChars\":{grp}," +
                $"\"historyTurns\":{turns}," +
                $"\"groupHistoryTurns\":{gturns}," +
                $"\"emoji\":\"{Api.Esc(emoji)}\"," +
                $"\"freeChat\":{(ChkFreeChat.IsChecked == true ? "true" : "false")}," +
                $"\"emotions\":{(ChkEmotions.IsChecked == true ? "true" : "false")}," +
                $"\"proactive\":{(ChkProactive.IsChecked == true ? "true" : "false")}," +
                $"\"opinions\":{(ChkOpinions.IsChecked == true ? "true" : "false")}," +
                $"\"links\":{(ChkLinks.IsChecked == true ? "true" : "false")}" +
                "}";

            var res = await Api.Post(_sup.Url, "/api/persona", json);
            if (!res.Ok)
            {
                SaveState.Text = "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
                return;
            }

            // 称呼（persona 接口不收，走 settings）和群聊「必须 @」走 config
            var owner = TxtOwner.Text.Trim();
            if (owner.Length > 0)
                await Api.Post(_sup.Url, "/api/settings", $"{{\"userName\":\"{Api.Esc(owner)}\"}}");
            var patch = "{\"patch\":{" +
                "\"group.requireAt\":" + (ChkRequireAt.IsChecked == true ? "true" : "false") + "," +
                "\"persona.masterRoast\":" + (ChkRoast.IsChecked == true ? "true" : "false") + "," +
                "\"persona.aliases\":" + Lines(TxtAliases) + "," +
                "\"persona.master.names\":" + Lines(TxtMasterNames) + "," +
                "\"persona.master.wxids\":" + Lines(TxtMasterWxids) +
                "}}";
            await Api.Post(_sup.Url, "/api/config", patch);

            SaveState.Text = okText + " · " + DateTime.Now.ToString("HH:mm:ss");
        }

        private async void OnImportPreset(object sender, RoutedEventArgs e)
        {
            if (!(CmbPreset.SelectedItem is PresetItem p)) return;
            var res = await Api.Post(_sup.Url, "/api/persona/preset", $"{{\"id\":\"{Api.Esc(p.Id)}\"}}");
            if (!res.Ok)
            {
                PresetResult.Text = "导入失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
                return;
            }
            PresetResult.Text = "已导入 " + p.Label + "，下面的字段已换成这一版。";
            _loaded = false;
            await LoadAsync();
        }

        /// <summary>JSON 数组 → 一行一个（给多行输入框用）</summary>
        private static string JoinLines(JsonElement parent, string name)
        {
            if (parent.ValueKind != JsonValueKind.Object || !parent.TryGetProperty(name, out var v)
                || v.ValueKind != JsonValueKind.Array) return "";
            return string.Join("\n", v.EnumerateArray()
                .Where(x => x.ValueKind == JsonValueKind.String)
                .Select(x => x.GetString() ?? "")
                .Where(x => x.Length > 0));
        }

        /// <summary>多行输入框 → JSON 数组字面量</summary>
        private static string Lines(System.Windows.Controls.TextBox box)
        {
            var items = (box.Text ?? "").Split('\n')
                .Select(x => x.Trim()).Where(x => x.Length > 0)
                .Select(x => "\"" + Api.Esc(x) + "\"");
            return "[" + string.Join(",", items) + "]";
        }

        private static string S(JsonElement e, string n)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

        private static bool B(JsonElement e, string n)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.True;

        private static long L(JsonElement e, string n)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(n, out var v)) return 0;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var x)) return x;
            if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), out var y)) return y;
            return 0;
        }
    }
}
