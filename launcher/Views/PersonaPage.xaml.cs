using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
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
        private bool _loadedOnline;
        private readonly SemaphoreSlim _saveGate = new SemaphoreSlim(1, 1);
        private string _loadedEmoji = "正常";   // 上次载入的颜文字档位，用来判断用户有没有改过

        /// <summary>
        /// 这些开关在各自专页已经有入口（微信桥接 / 主动与提醒 / 表情包），
        /// 人设页不再重复列一份，避免同一个键两处可改、改完另一处不刷新。
        /// </summary>
        private static readonly HashSet<string> HiddenFlags = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "wechatAccountGuard", "quoteReply", "stickers",
            "proactiveCare", "careOnlyMaster", "careGroups", "careOthers",
        };

        private string _currentPresetId = "";   // 当前人设来自哪一版，用来把下拉框选到正确项

        public PersonaPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;

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
            if (_loaded && _loadedOnline == _sup.NodeRunning) return;
            await LoadAsync();
        }

        private async Task LoadAsync()
        {
            var res = await _sup.ReadConfigurationAsync("/api/persona");
            if (!res.Ok) { SaveState.Text = res.Error; return; }

            var set = await _sup.ReadConfigurationAsync("/api/settings");
            var cfg = await _sup.ReadConfigurationAsync("/api/config");

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
                    TxtBubbles.Text = L(p, "maxBubbles").ToString();
                    TxtTurns.Text = L(p, "historyTurns").ToString();
                    TxtGroupTurns.Text = L(p, "groupHistoryTurns").ToString();
                    var emoji = S(p, "emoji");
                    _loadedEmoji = string.IsNullOrEmpty(emoji) ? "正常" : emoji;
                    SldEmoji.Value = EmojiPercent(cfg, _loadedEmoji);
                    UpdateEmojiHint();

                    ChkEmotions.IsChecked = B(p, "emotions");
                    ChkProactive.IsChecked = B(p, "proactive");
                    ChkOpinions.IsChecked = B(p, "opinions");
                    ChkLinks.IsChecked = B(p, "links");

                    var src = S(p, "sourcePreset");
                    _currentPresetId = src;
                    CurrentPreset.Text = string.IsNullOrEmpty(src) ? "人设：手写/默认" : "人设：来自 " + src;
                }

                if (set.Ok) TxtOwner.Text = set.Str("userName");

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

            await LoadPresetsAsync(_currentPresetId);
            await LoadFlagsAsync();
            await LoadMemoryChatsAsync();
            _loaded = true;
            _loadedOnline = _sup.NodeRunning;
            ConfigurationControls.SetReadOnly(Body, !_loadedOnline);
            SaveState.Text = _loadedOnline ? "" : "已读取本地配置 · 启动内核后可修改";
            PresetSaved.Text = "";
        }

        private sealed class MemoryChatItem
        {
            public string Key { get; set; }
            public string Title { get; set; }
            public string Label { get; set; }
        }

        private async Task LoadMemoryChatsAsync()
        {
            BtnResetMemory.IsEnabled = false;
            CmbMemoryChat.ItemsSource = null;
            if (!_sup.NodeRunning)
            {
                MemoryHint.Text = "请先启动内核，再刷新对话列表。";
                return;
            }
            var res = await Api.Get(_sup.Url, "/api/memory/chats");
            if (!res.Ok)
            {
                MemoryHint.Text = "读取对话失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
                return;
            }
            var groups = new List<MemoryChatItem>();
            var arr = res.Prop("chats");
            if (arr.ValueKind == JsonValueKind.Array)
                foreach (var g in arr.EnumerateArray())
                {
                    var title = S(g, "title");
                    var key = S(g, "key");
                    groups.Add(new MemoryChatItem { Key = key, Title = title,
                        Label = $"【{(S(g, "chatType") == "group" ? "群聊" : "私聊")}】{title} · {L(g, "messageCount")} 条记录 · {L(g, "peopleCount")} 人记忆（{key}）" });
                }
            CmbMemoryChat.ItemsSource = groups;
            if (groups.Count > 0) CmbMemoryChat.SelectedIndex = 0;
            BtnResetMemory.IsEnabled = groups.Count > 0;
            MemoryHint.Text = groups.Count > 0 ? "列出鲸鲸当前保存了记忆的所有对话，包含群聊和私聊。" : "暂无已保存记忆的对话。";
        }

        private async void OnRefreshMemoryChats(object sender, RoutedEventArgs e)
        {
            BtnRefreshMemory.IsEnabled = false;
            try { await LoadMemoryChatsAsync(); }
            finally { BtnRefreshMemory.IsEnabled = true; }
        }

        private async void OnResetChatMemory(object sender, RoutedEventArgs e)
        {
            if (!_sup.NodeRunning || CmbMemoryChat.SelectedItem is not MemoryChatItem group) return;
            var result = MessageBox.Show(Window.GetWindow(this),
                $"确定清空「{group.Title}」的全部内部记忆吗？\n\n" +
                "将清除：上下文聊天记录、摘要、人物卡、事件与关系记忆。\n" +
                "微信聊天记录、其他会话记忆和人设设置保留。\n\n" +
                "此操作无法直接撤销；之后从新消息开始记忆。已有的手动备份与自动快照保留。",
                "清空该对话记忆", MessageBoxButton.YesNo, MessageBoxImage.Warning, MessageBoxResult.No);
            if (result != MessageBoxResult.Yes) return;
            BtnResetMemory.IsEnabled = false;
            BtnRefreshMemory.IsEnabled = false;
            CmbMemoryChat.IsEnabled = false;
            try
            {
                var res = await Api.Post(_sup.Url, "/api/memory/chats/reset",
                    JsonSerializer.Serialize(new { key = group.Key, confirm = true }));
                if (!res.Ok)
                {
                    MemoryHint.Text = "清空失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
                    return;
                }
                await LoadMemoryChatsAsync();
                MemoryHint.Text = $"已清空「{group.Title}」的内部记忆，微信聊天记录保留。";
            }
            finally
            {
                BtnRefreshMemory.IsEnabled = true;
                CmbMemoryChat.IsEnabled = true;
                BtnResetMemory.IsEnabled = CmbMemoryChat.SelectedItem != null;
            }
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

        private async Task LoadPresetsAsync(string currentId = "")
        {
            var res = await _sup.ReadConfigurationAsync("/api/persona/presets");
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
            // 选中「当前人设实际来自哪一版」，而不是永远选第一个，
            // 否则导入 v4 再保存，下拉框会跳回 v1，看起来像没导入成功。
            var hit = items.FirstOrDefault(x => string.Equals(x.Id, currentId, StringComparison.OrdinalIgnoreCase));
            if (hit != null) CmbPreset.SelectedItem = hit;
            else if (items.Count > 0) CmbPreset.SelectedIndex = 0;
            else PresetSaved.Text = "presets 目录里没有人设版本。";
        }

        private async Task LoadFlagsAsync()
        {
            FlagsHost.Children.Clear();
            var res = await _sup.ReadConfigurationAsync("/api/features");
            if (!res.Ok) return;
            var arr = res.Prop("features");
            if (arr.ValueKind != JsonValueKind.Array) return;

            foreach (var f in arr.EnumerateArray())
            {
                var key = S(f, "key");
                if (HiddenFlags.Contains(key)) continue;   // 有专页的开关不在这里重复
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

        private void OnEmojiChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            UpdateEmojiHint();
            if (_loading) return;
            _saveTimer.Stop();
            _saveTimer.Start();
        }

        private void UpdateEmojiHint()
        {
            if (HintEmoji == null || SldEmoji == null) return;
            var pct = (int)Math.Round(SldEmoji.Value);
            if (pct <= 0)
            {
                HintEmoji.Text = "关闭：不主动带颜文字";
                return;
            }
            var every = Math.Max(1, (int)Math.Round(100.0 / pct));
            HintEmoji.Text = pct + "% · 约每 " + every + " 条带一次";
        }

        /// <summary>拖动条位置：优先用显式概率，没设过就按档位换算（关/少/正常/多 → 0/12/30/65）。</summary>
        private static double EmojiPercent(ApiResult cfg, string level)
        {
            if (cfg != null && cfg.Ok && cfg.Prop("config").ValueKind == JsonValueKind.Object
                && cfg.Prop("config").TryGetProperty("chat", out var chat) && chat.ValueKind == JsonValueKind.Object
                && chat.TryGetProperty("emojiChance", out var ec) && ec.ValueKind == JsonValueKind.Number)
            {
                var explicitPct = ec.GetDouble() * 100;
                if (explicitPct > 0) return Math.Clamp(explicitPct, 0, 100);
            }
            return level switch
            {
                "关" => 0,
                "少" => 12,
                "多" => 65,
                _ => 30
            };
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
            await _saveGate.WaitAsync();
            try
            {
            if (_loading || !_sup.NodeRunning) return;

            int age = int.TryParse(TxtAge.Text.Trim(), out var a) ? Math.Clamp(a, 1, 120) : 23;
            int priv = int.TryParse(TxtPrivate.Text.Trim(), out var pv) ? Math.Clamp(pv, 40, 800) : 140;
            int grp = int.TryParse(TxtGroup.Text.Trim(), out var gv) ? Math.Clamp(gv, 20, 300) : 70;
            int turns = int.TryParse(TxtTurns.Text.Trim(), out var tv) ? Math.Clamp(tv, 4, 400) : 200;
            int gturns = int.TryParse(TxtGroupTurns.Text.Trim(), out var gtv) ? Math.Clamp(gtv, 2, 300) : 150;
            int bubbles = int.TryParse(TxtBubbles.Text.Trim(), out var bv) ? Math.Clamp(bv, 1, 8) : 2;

            var pct = Math.Clamp((int)Math.Round(SldEmoji.Value), 0, 100);
            // 0% 用档位「关」做硬关；>0 时把档位恢复成可用值，真正生效的是下面的精确概率
            var emoji = pct == 0
                ? "关"
                : (string.Equals(_loadedEmoji, "关", StringComparison.Ordinal) ? "正常" : _loadedEmoji);
            var emojiChance = pct / 100.0;

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
                $"\"maxBubbles\":{bubbles}," +
                $"\"historyTurns\":{turns}," +
                $"\"groupHistoryTurns\":{gturns}," +
                $"\"emoji\":\"{Api.Esc(emoji)}\"," +
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

            // 称呼（persona 接口不收，走 settings）；群聊规则统一在「设置 → 群聊」，这里不再写 config
            var owner = TxtOwner.Text.Trim();
            var ownerResult = await Api.Post(_sup.Url, "/api/settings", $"{{\"userName\":\"{Api.Esc(owner)}\"}}");
            if (!ownerResult.Ok)
            {
                SaveState.Text = "人设已保存，但称呼保存失败：" + ownerResult.Error;
                return;
            }
            var patch = "{\"patch\":{" +
                "\"persona.masterRoast\":" + (ChkRoast.IsChecked == true ? "true" : "false") + "," +
                "\"persona.aliases\":" + Lines(TxtAliases) + "," +
                "\"persona.master.names\":" + Lines(TxtMasterNames) + "," +
                "\"persona.master.wxids\":" + Lines(TxtMasterWxids) + "," +
                "\"chat.emojiChance\":" + emojiChance.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) +
                "}}";
            var configResult = await Api.Post(_sup.Url, "/api/config", patch);
            if (!configResult.Ok)
            {
                SaveState.Text = "人设与称呼已保存，但其他设置保存失败：" + configResult.Error;
                return;
            }
            _loadedEmoji = emoji;

            SaveState.Text = okText + " · " + DateTime.Now.ToString("HH:mm:ss");
            PresetSaved.Text = "✔ 已保存";
            PresetSaved.Foreground = (Brush)FindResource("Text");
            }
            finally { _saveGate.Release(); }
        }

        private async void OnImportPreset(object sender, RoutedEventArgs e)
        {
            if (!_sup.NodeRunning) { SaveState.Text = "请先启动内核，再导入预设。"; return; }
            if (!(CmbPreset.SelectedItem is PresetItem p)) return;
            var res = await Api.Post(_sup.Url, "/api/persona/preset", $"{{\"id\":\"{Api.Esc(p.Id)}\"}}");
            if (!res.Ok)
            {
                PresetSaved.Text = "导入失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
                PresetSaved.Foreground = (Brush)FindResource("Bad");
                return;
            }
            _loaded = false;
            await LoadAsync();                       // LoadAsync 会按新的 sourcePreset 选中下拉框
            PresetSaved.Text = "✔ 已保存";
            PresetSaved.Foreground = (Brush)FindResource("Text");
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
