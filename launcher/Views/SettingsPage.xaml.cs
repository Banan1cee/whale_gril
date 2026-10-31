using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Win32;

namespace WhaleLauncher.Views
{
    /// <summary>一个可编辑的配置项。启动器是唯一界面，所以这里就是「全部设置」的清单。</summary>
    public sealed class FieldSpec
    {
        public string Path;
        public string Label;
        public string Kind = "text";      // bool / num / text / secret / select / multiline
        public string Hint = "";
        public double Min = double.NaN;
        public double Max = double.NaN;
        public string[] Options;
        public bool IsInt = true;
        public string Unit = "";          // 拖动条右侧读数后缀，比如「 条/分钟」
    }

    public sealed class SectionSpec
    {
        public string Title;
        public string Note = "";
        public List<FieldSpec> Fields = new List<FieldSpec>();
    }

    public sealed class ProviderItem
    {
        public string Key { get; set; }
        public string Label { get; set; }
        public override string ToString() => Label ?? Key ?? "";
    }

    public partial class SettingsPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly Dictionary<string, Action<JsonElement>> _loaders = new Dictionary<string, Action<JsonElement>>();
        private Action<JsonElement, Dictionary<string, JsonElement>> _loadModel;
        private Action<JsonElement> _loadVision;
        private Dictionary<string, JsonElement> _providers;
        private bool _loading;
        private bool _configLoaded;      // 已经成功全量回填过一次（M30：周期刷新据此判断要不要补）
        private bool _loadingConfig;     // 全量回填在途，防止载入和定时器双跑
        private DateTime _lastLoad = DateTime.MinValue;
        private readonly List<Border> _sectionCards = new List<Border>();

        public SettingsPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            BuildOnce();
            Loaded += async (_, __) =>
            {
                if (SettingsNav.SelectedIndex != 0) SettingsNav.SelectedIndex = 0;
                MainScroll.ScrollToTop();
                await LoadConfigAsync();   // 页面载入才全量回填（M30）
            };
        }

        // ── 全部设置清单（启动器是唯一界面）────────────────────────
        private static List<SectionSpec> Specs() => new List<SectionSpec>
        {
            new SectionSpec { Title = "语音", Note = "别人发语音时先转成文字再回复；超时和时长上限也在这张卡里。", Fields =
            {
                new FieldSpec { Path = "voice.enabled", Label = "语音回复", Kind = "bool" },
                new FieldSpec { Path = "voice.apiKey", Label = "语音接口 Key", Kind = "secret", Hint = "留空表示不改；留空则用主模型的 Key" },
                new FieldSpec { Path = "voice.baseUrl", Label = "语音接口地址", Kind = "text" },
                new FieldSpec { Path = "voice.model", Label = "语音模型", Kind = "text" },
                new FieldSpec { Path = "voice.timeoutMs", Label = "语音识别超时(毫秒)", Kind = "num", Min = 1000, Max = 300000 },
                new FieldSpec { Path = "voice.maxSeconds", Label = "超过多少秒的语音不转", Kind = "num", Min = 1, Max = 600 },
            }},
            new SectionSpec { Title = "群聊", Fields =
            {
                new FieldSpec { Path = "group.requireAt", Label = "必须 @ 她才回", Kind = "bool", Hint = "关掉 = 群里不 @ 也会接，但按下面的插话概率抽，不是每条都回" },
                new FieldSpec { Path = "group.freeChat", Label = "允许她自己插话", Kind = "bool", Hint = "开着时没点名的消息也按概率抽一句；@ 她的不受影响" },
                new FieldSpec { Path = "group.freeChatChance", Label = "插话概率（0.06=6%，1=每条都回）", Kind = "num", Min = 0, Max = 1, IsInt = false, Hint = "没点名的消息按这个概率接一句；默认 0.06 约等于 16 条回 1 条。填 1 = 每条都回，仍受冷却和每分钟上限约束" },
                new FieldSpec { Path = "group.cooldownSec", Label = "两次回复冷却(秒)", Kind = "num", Min = 0, Max = 3600 },
                new FieldSpec { Path = "group.maxRepliesPerMinute", Label = "每分钟最多回几条", Kind = "slider", Min = 5, Max = 30, Unit = " 条/分钟", Hint = "推荐 10–20 条" },
                new FieldSpec { Path = "group.masterAlwaysReply", Label = "主人在群里说话永远回", Kind = "bool" },
                new FieldSpec { Path = "group.engagedMinutes", Label = "接话后保持参与(分钟)", Kind = "num", Min = 1, Max = 1440 },
                new FieldSpec { Path = "group.silentMinutes", Label = "冷场多久算话题结束(分钟)", Kind = "num", Min = 1, Max = 10080 },
                new FieldSpec { Path = "group.muteDefaultMinutes", Label = "免打扰默认时长(分钟)", Kind = "num", Min = 1, Max = 1440 },
            }},
            new SectionSpec { Title = "微信 · 数据与管道", Fields =
            {
                new FieldSpec { Path = "wechat.dbDir", Label = "微信文件保存位置", Kind = "text", Hint = "留空 = 自动找；填到 xwechat_files 这一层" },
                new FieldSpec { Path = "wechat.staleAfterSec", Label = "多久没消息算去忙(秒)", Kind = "num", Min = 60, Max = 86400 },
                new FieldSpec { Path = "wechat.ignoreSenders", Label = "这些会话永不回复", Kind = "multiline", Hint = "一行一个（微信团队、订阅号…）" },
                new FieldSpec { Path = "wechat.pipelineWorkers", Label = "同时处理几个会话", Kind = "num", Min = 1, Max = 8 },
                new FieldSpec { Path = "wechat.pipelineQueueLimit", Label = "单个会话最多积压几条", Kind = "num", Min = 1, Max = 32, Hint = "超出就丢掉最早的一条；默认 8" },
            }},
            new SectionSpec { Title = "联网与链接", Fields =
            {
                new FieldSpec { Path = "websearch.enabled", Label = "联网搜索", Kind = "bool" },
                new FieldSpec { Path = "websearch.city", Label = "搜索城市", Kind = "text" },
                new FieldSpec { Path = "websearch.timeoutMs", Label = "搜索超时(毫秒)", Kind = "num", Min = 1000, Max = 30000 },
                new FieldSpec { Path = "links.enabled", Label = "解析聊天里的链接", Kind = "bool" },
                new FieldSpec { Path = "links.timeoutMs", Label = "链接超时(毫秒)", Kind = "num", Min = 1000, Max = 30000 },
                new FieldSpec { Path = "links.cacheMinutes", Label = "链接缓存(分钟)", Kind = "num", Min = 0, Max = 1440 },
            }},
            new SectionSpec { Title = "网关", Note = "给别的客户端接入用；桥接自己用的是这套，一般不用改。", Fields =
            {
                new FieldSpec { Path = "gateway.wechat.enabled", Label = "微信网关", Kind = "bool" },
                new FieldSpec { Path = "gateway.wechat.inboundToken", Label = "微信 token", Kind = "secret", Hint = "留空表示不改" },
                new FieldSpec { Path = "gateway.wechat.outboundUrl", Label = "微信出站地址", Kind = "text" },
                new FieldSpec { Path = "gateway.douyin.enabled", Label = "抖音网关", Kind = "bool" },
                new FieldSpec { Path = "gateway.douyin.inboundToken", Label = "抖音 token", Kind = "secret", Hint = "留空表示不改" },
                new FieldSpec { Path = "gateway.douyin.outboundUrl", Label = "抖音出站地址", Kind = "text" },
            }},
            new SectionSpec { Title = "高级", Note = "改完要重启的项都在这里；管理员口令也归这一组，平时不用碰。", Fields =
            {
                new FieldSpec { Path = "server.host", Label = "监听地址", Kind = "text", Hint = "只给本机用就 127.0.0.1；0.0.0.0 = 同 WiFi 也能连（改完重启）" },
                new FieldSpec { Path = "server.openBrowser", Label = "启动时自动开浏览器", Kind = "bool" },
                new FieldSpec { Path = "server.port", Label = "本机端口", Kind = "num", Min = 1024, Max = 65535, Hint = "改完重启生效" },
                new FieldSpec { Path = "log.level", Label = "日志级别（界面 / 控制台）", Kind = "select", Options = new[] { "debug", "info", "error" }, Hint = "只影响界面和启动器控制台；日志文件始终记 debug 全量（data/whale.log、data/wechat-bridge-4x.log），改完重启生效" },
                new FieldSpec { Path = "storage.mediaKeepDays", Label = "媒体缓存保留几天", Kind = "num", Min = 0, Max = 90 },
                new FieldSpec { Path = "storage.mediaMaxMB", Label = "媒体缓存上限(MB)", Kind = "num", Min = 0, Max = 10000 },
                new FieldSpec { Path = "admin.spell", Label = "管理员口令", Kind = "text", Hint = "在微信里发这句获得权限；留空 = 关闭" },
                new FieldSpec { Path = "admin.minutes", Label = "权限有效期(分钟)", Kind = "num", Min = 1, Max = 1440 },
                new FieldSpec { Path = "admin.allowAll", Label = "谁发都给权限", Kind = "bool", Hint = "关掉 = 只有主人发才给" },
            }},
        };

        private void BuildOnce()
        {
            SectionsHost.Children.Clear();
            SettingsNav.Items.Clear();
            _sectionCards.Clear();

            AddSection("模型与 Key", BuildModelSection());
            AddSection("看图（视觉模型）", BuildVisionSection());
            foreach (var spec in Specs()) AddSection(spec.Title, BuildSection(spec));
            AddSection("外观", BuildAppearanceSection());

            SettingsNav.SelectedIndex = 0;
        }

        private void AddSection(string navTitle, Border card)
        {
            SettingsNav.Items.Add(navTitle);
            _sectionCards.Add(card);
            card.Tag = navTitle;
            SectionsHost.Children.Add(card);
        }

        private void OnSettingsNavChanged(object sender, SelectionChangedEventArgs e)
        {
            var i = SettingsNav.SelectedIndex;
            if (i < 0 || i >= _sectionCards.Count) return;
            try
            {
                var y = _sectionCards[i].TranslatePoint(new Point(0, 0), SectionsHost).Y;
                MainScroll.ScrollToVerticalOffset(Math.Max(0, y - 4));
            }
            catch { }
        }

        // ── 外观：深浅色 + 背景图（只影响启动器）────────────────
        private Border BuildAppearanceSection()
        {
            var card = Card("外观", "只影响启动器界面：深浅色和背景图。不会写进 config.json，也不影响她的人设和聊天。", out var body);

            var dark = new CheckBox
            {
                Content = "深色模式（关掉就是浅色）",
                IsChecked = Appearance.IsDark,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Center
            };
            dark.Click += (_, __) => Appearance.SetTheme(dark.IsChecked == true ? "dark" : "light");
            body.Children.Add(Row("主题", dark, "顶栏右上角的太阳 / 月亮也能快速切换"));

            var preview = new Border
            {
                Width = 216,
                Height = 116,
                CornerRadius = new CornerRadius(12),
                BorderThickness = new Thickness(1),
                ClipToBounds = true,
                HorizontalAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(0, 0, 0, 8)
            };
            preview.SetResourceReference(Border.BackgroundProperty, "Surface3");
            preview.SetResourceReference(Border.BorderBrushProperty, "CardBorder");
            var img = new Image { Stretch = Stretch.UniformToFill };
            var empty = new TextBlock
            {
                Text = "未设置背景图",
                Style = (Style)FindResource("Small"),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            var previewGrid = new Grid();
            previewGrid.Children.Add(img);
            previewGrid.Children.Add(empty);
            preview.Child = previewGrid;

            var pathText = new TextBlock
            {
                Style = (Style)FindResource("Small"),
                TextWrapping = TextWrapping.Wrap,
                HorizontalAlignment = HorizontalAlignment.Left,
                MaxWidth = 560,
                Margin = new Thickness(0, 0, 0, 8)
            };
            var pick = new Button { Content = "选择图片…", Style = (Style)FindResource("Ghost") };
            var clear = new Button { Content = "清除背景", Style = (Style)FindResource("Ghost"), Margin = new Thickness(8, 0, 0, 0) };
            var actions = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Left };
            actions.Children.Add(pick);
            actions.Children.Add(clear);

            var hint = new TextBlock
            {
                Style = (Style)FindResource("Small"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 8, 0, 0)
            };

            var panel = new StackPanel();
            panel.Children.Add(preview);
            panel.Children.Add(pathText);
            panel.Children.Add(actions);
            panel.Children.Add(hint);
            body.Children.Add(Row("背景图片", panel,
                "支持 JPG / PNG / BMP，会自动压一层主题蒙版并模糊。浅色模式建议配浅色图，深色模式建议配深色图，文字更清楚。", true));

            void Refresh()
            {
                dark.IsChecked = Appearance.IsDark;
                var bmp = Appearance.LoadBackdrop();
                img.Source = bmp;
                img.Visibility = bmp == null ? Visibility.Collapsed : Visibility.Visible;
                empty.Visibility = bmp == null ? Visibility.Visible : Visibility.Collapsed;
                clear.IsEnabled = !string.IsNullOrEmpty(Appearance.Backdrop);
                pathText.Text = string.IsNullOrEmpty(Appearance.Backdrop)
                    ? "当前使用纯色背景。"
                    : "当前：" + Appearance.Backdrop;
            }

            pick.Click += (_, __) =>
            {
                var dlg = new OpenFileDialog
                {
                    Title = "选择背景图片",
                    Filter = "图片文件|*.jpg;*.jpeg;*.png;*.bmp|所有文件|*.*",
                    CheckFileExists = true
                };
                if (dlg.ShowDialog() != true) return;
                if (Appearance.TrySetBackdrop(dlg.FileName, out var err))
                {
                    hint.Text = "已应用。";
                    hint.Foreground = (Brush)FindResource("Dim");
                }
                else
                {
                    hint.Text = err;
                    hint.Foreground = (Brush)FindResource("Bad");
                }
                Refresh();
            };

            clear.Click += (_, __) =>
            {
                Appearance.ClearBackdrop();
                hint.Text = "已恢复纯色背景。";
                hint.Foreground = (Brush)FindResource("Dim");
                Refresh();
            };

            Appearance.Changed += Refresh;
            Refresh();
            return card;
        }

        // ── 卡片与行 ────────────────────────────────────────────
        private Border Card(string title, string note, out StackPanel body)
        {
            var border = new Border
            {
                Style = (Style)FindResource("Card"),
                Padding = new Thickness(16, 14, 16, 14),
                Margin = new Thickness(0, 0, 0, 12)
            };
            var stack = new StackPanel();
            stack.Children.Add(new TextBlock { Text = title, Style = (Style)FindResource("H2") });
            if (!string.IsNullOrEmpty(note))
                stack.Children.Add(new TextBlock { Text = note, Style = (Style)FindResource("Small"), Margin = new Thickness(0, 6, 0, 0), TextWrapping = TextWrapping.Wrap });
            body = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
            stack.Children.Add(body);
            border.Child = stack;
            return border;
        }

        private Grid Row(string label, FrameworkElement control, string hint, bool top = false)
        {
            var grid = new Grid { Margin = new Thickness(0, 0, 0, 8) };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(210) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.Children.Add(new TextBlock
            {
                Text = label,
                Style = (Style)FindResource("Label"),
                VerticalAlignment = top ? VerticalAlignment.Top : VerticalAlignment.Center,
                Margin = top ? new Thickness(0, 2, 0, 0) : new Thickness(0),
                TextWrapping = TextWrapping.Wrap
            });
            var right = new StackPanel { HorizontalAlignment = HorizontalAlignment.Stretch };
            right.Children.Add(control);
            if (!string.IsNullOrEmpty(hint))
                right.Children.Add(new TextBlock { Text = hint, Style = (Style)FindResource("Small"), Margin = new Thickness(0, 3, 0, 0), TextWrapping = TextWrapping.Wrap });
            Grid.SetColumn(right, 1);
            grid.Children.Add(right);
            return grid;
        }

        private Border BuildSection(SectionSpec spec)
        {
            var card = Card(spec.Title, spec.Note, out var body);
            foreach (var f in spec.Fields) body.Children.Add(BuildField(f));
            return card;
        }

        // ── 单个字段 ────────────────────────────────────────────
        private FrameworkElement BuildField(FieldSpec f)
        {
            switch (f.Kind)
            {
                case "bool":
                {
                    var chk = new CheckBox { VerticalAlignment = VerticalAlignment.Center };
                    chk.Click += async (s, e) =>
                    {
                        if (_loading) return;
                        await PatchAsync(f.Path, ((CheckBox)s).IsChecked == true ? "true" : "false");
                    };
                    _loaders[f.Path] = v => { if (chk.IsKeyboardFocusWithin) return; _loading = true; chk.IsChecked = v.ValueKind == JsonValueKind.True; _loading = false; };
                    return Row(f.Label, chk, f.Hint);
                }
                case "select":
                {
                    var cmb = new ComboBox { Height = 26, ItemsSource = f.Options, MinWidth = 140, HorizontalAlignment = HorizontalAlignment.Left };
                    cmb.SelectionChanged += async (s, e) =>
                    {
                        if (_loading || cmb.SelectedItem == null) return;
                        await PatchAsync(f.Path, "\"" + Api.Esc((string)cmb.SelectedItem) + "\"");
                    };
                    _loaders[f.Path] = v =>
                    {
                        if (cmb.IsKeyboardFocusWithin) return;   // 正在编辑就不覆盖（M30）
                        _loading = true;
                        cmb.SelectedItem = v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                        _loading = false;
                    };
                    return Row(f.Label, cmb, f.Hint);
                }
                case "secret":
                {
                    var pwd = new PasswordBox();
                    pwd.LostFocus += async (s, e) =>
                    {
                        if (_loading || pwd.Password.Length == 0) return;
                        await PatchAsync(f.Path, "\"" + Api.Esc(pwd.Password.Trim()) + "\"");
                        pwd.Password = "";
                        StatusText.Text = f.Label + " 已保存。";
                    };
                    return Row(f.Label, pwd, f.Hint);
                }
                case "multiline":
                {
                    var box = new TextBox { AcceptsReturn = true, MinHeight = 56, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
                    box.LostFocus += async (s, e) =>
                    {
                        if (_loading) return;
                        var lines = (box.Text ?? "").Split('\n').Select(x => x.Trim()).Where(x => x.Length > 0).ToArray();
                        await PatchAsync(f.Path, "[" + string.Join(",", lines.Select(p => "\"" + Api.Esc(p) + "\"")) + "]");
                    };
                    _loaders[f.Path] = v =>
                    {
                        if (box.IsKeyboardFocusWithin) return;   // 正在编辑就不覆盖（M30）
                        _loading = true;
                        box.Text = v.ValueKind == JsonValueKind.Array
                            ? string.Join("\n", v.EnumerateArray().Select(x => x.ToString()))
                            : (v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "");
                        _loading = false;
                    };
                    return Row(f.Label, box, f.Hint);
                }
                case "num":
                {
                    var box = new TextBox { Width = 120, HorizontalAlignment = HorizontalAlignment.Left };
                    box.LostFocus += async (s, e) =>
                    {
                        if (_loading) return;
                        if (!double.TryParse((box.Text ?? "").Trim(), out var n))
                        {
                            StatusText.Text = f.Label + "：要填数字";
                            return;
                        }
                        if (!double.IsNaN(f.Min)) n = Math.Max(f.Min, n);
                        if (!double.IsNaN(f.Max)) n = Math.Min(f.Max, n);
                        if (f.IsInt) { n = Math.Round(n); box.Text = n.ToString(); }
                        await PatchAsync(f.Path, f.IsInt ? n.ToString() : n.ToString("0.###"));
                    };
                    _loaders[f.Path] = v =>
                    {
                        if (box.IsKeyboardFocusWithin) return;   // 正在编辑就不覆盖（M30）
                        _loading = true;
                        box.Text = v.ValueKind == JsonValueKind.Number
                            ? (f.IsInt ? Math.Round(v.GetDouble()).ToString() : v.GetDouble().ToString("0.###"))
                            : "";
                        _loading = false;
                    };
                    return Row(f.Label, box, f.Hint);
                }
                case "slider":
                {
                    // 拖动条：拖动时只更新右侧读数，停手 450ms 才写回（避免拖一次发几十个 PATCH）
                    var slider = new Slider
                    {
                        Minimum = double.IsNaN(f.Min) ? 0 : f.Min,
                        Maximum = double.IsNaN(f.Max) ? 100 : f.Max,
                        TickFrequency = 1,
                        IsSnapToTickEnabled = true,
                        Width = 220,
                        VerticalAlignment = VerticalAlignment.Center
                    };
                    var readout = new TextBlock
                    {
                        Style = (Style)FindResource("Small"),
                        VerticalAlignment = VerticalAlignment.Center,
                        Margin = new Thickness(12, 0, 0, 0)
                    };
                    var debounce = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(450) };
                    debounce.Tick += async (s, e) =>
                    {
                        debounce.Stop();
                        if (_loading) return;
                        await PatchAsync(f.Path, Math.Round(slider.Value).ToString());
                    };
                    void ShowValue() => readout.Text = Math.Round(slider.Value) + (f.Unit ?? "");
                    slider.ValueChanged += (s, e) =>
                    {
                        ShowValue();
                        if (_loading) return;
                        debounce.Stop();
                        debounce.Start();
                    };
                    _loaders[f.Path] = v =>
                    {
                        _loading = true;
                        if (v.ValueKind == JsonValueKind.Number)
                        {
                            var n = v.GetDouble();
                            if (!double.IsNaN(f.Min)) n = Math.Max(f.Min, n);
                            if (!double.IsNaN(f.Max)) n = Math.Min(f.Max, n);
                            slider.Value = Math.Round(n);
                        }
                        _loading = false;
                        ShowValue();
                    };
                    var panel = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Left };
                    panel.Children.Add(slider);
                    panel.Children.Add(readout);
                    return Row(f.Label, panel, f.Hint);
                }
                default:
                {
                    var box = new TextBox();
                    box.LostFocus += async (s, e) =>
                    {
                        if (_loading) return;
                        await PatchAsync(f.Path, "\"" + Api.Esc((box.Text ?? "").Trim()) + "\"");
                    };
                    _loaders[f.Path] = v =>
                    {
                        if (box.IsKeyboardFocusWithin) return;   // 正在编辑就不覆盖（M30）
                        _loading = true;
                        box.Text = v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "")
                            : (v.ValueKind == JsonValueKind.Array ? string.Join(",", v.EnumerateArray().Select(x => x.ToString())) : "");
                        _loading = false;
                    };
                    return Row(f.Label, box, f.Hint);
                }
            }
        }

        private async Task PatchAsync(string path, string jsonLiteral)
        {
            var body = "{\"patch\":{\"" + Api.Esc(path) + "\":" + jsonLiteral + "}}";
            var res = await Api.Post(_sup.Url, "/api/config", body);
            StatusText.Text = res.Ok
                ? path + " 已保存 " + DateTime.Now.ToString("HH:mm:ss")
                : path + " 保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
        }

        // ── 模型 / 看图 / 关于 ───────────────────────────────────
        private Border BuildModelSection()
        {
            var card = Card("模型与 Key", "选哪家模型、用哪把钥匙。", out var body);
            var items = new List<ProviderItem>();
            var cmb = new ComboBox { Height = 28, DisplayMemberPath = "Label", MinWidth = 320, HorizontalAlignment = HorizontalAlignment.Left };
            var baseUrl = new TextBox();
            var model = new TextBox();
            var key = new PasswordBox();
            var mock = new CheckBox();
            var result = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) };

            cmb.SelectionChanged += (s, e) =>
            {
                if (_loading || !(cmb.SelectedItem is ProviderItem p)) return;
                if (_providers != null && _providers.TryGetValue(p.Key, out var pv))
                {
                    baseUrl.Text = GetStr(pv, "baseUrl");
                    model.Text = GetStr(pv, "model");
                }
            };

            body.Children.Add(Row("模型服务", cmb, ""));
            body.Children.Add(Row("接口地址", baseUrl, ""));
            body.Children.Add(Row("模型名", model, ""));
            body.Children.Add(Row("API Key", key, "留空表示不改；已存的这里不会显示"));
            body.Children.Add(Row("演示模式", mock, "不连模型，用内置台词"));

            // 采样参数也放这张卡：以前只在网页里能改，启动器用户根本看不到。
            body.Children.Add(BuildField(new FieldSpec { Path = "deepseek.temperature", Label = "温度", Kind = "num", Min = 0, Max = 2, IsInt = false, Hint = "越大越放得开；超过 1.2 容易越聊越离谱" }));
            body.Children.Add(BuildField(new FieldSpec { Path = "deepseek.maxTokens", Label = "单次最多生成多少 token", Kind = "num", Min = 16, Max = 32768, Hint = "默认 700；具体字数因模型而异" }));
            body.Children.Add(BuildField(new FieldSpec { Path = "deepseek.frequencyPenalty", Label = "频率惩罚（减少复读）", Kind = "num", Min = -2, Max = 2, IsInt = false }));
            body.Children.Add(BuildField(new FieldSpec { Path = "deepseek.presencePenalty", Label = "在场惩罚（鼓励换话题）", Kind = "num", Min = -2, Max = 2, IsInt = false }));
            body.Children.Add(BuildField(new FieldSpec { Path = "deepseek.timeoutMs", Label = "请求超时(毫秒)", Kind = "num", Min = 1000, Max = 600000 }));

            var buttons = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) };
            var save = new Button { Content = "保存", Style = (Style)FindResource("Primary") };
            var test = new Button { Content = "测试连通", Style = (Style)FindResource("Ghost"), Margin = new Thickness(8, 0, 0, 0) };
            buttons.Children.Add(save);
            buttons.Children.Add(test);
            body.Children.Add(buttons);
            body.Children.Add(result);

            save.Click += async (s, e) =>
            {
                var prov = (cmb.SelectedItem as ProviderItem)?.Key ?? "";
                var json = "{"
                    + "\"provider\":\"" + Api.Esc(prov) + "\","
                    + "\"baseUrl\":\"" + Api.Esc(baseUrl.Text.Trim()) + "\","
                    + "\"model\":\"" + Api.Esc(model.Text.Trim()) + "\","
                    + "\"mock\":" + (mock.IsChecked == true ? "true" : "false")
                    + (key.Password.Length > 0 ? ",\"apiKey\":\"" + Api.Esc(key.Password.Trim()) + "\"" : "")
                    + "}";
                var res = await Api.Post(_sup.Url, "/api/settings", json);
                if (!res.Ok) { result.Text = "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw); return; }
                key.Password = "";
                result.Text = "已保存。";
            };
            test.Click += async (s, e) =>
            {
                result.Text = "正在测…";
                var res = await Api.Post(_sup.Url, "/api/settings/test", "{}");
                result.Text = res.Ok ? "连通正常。" : "测试没通过：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            };

            _loadModel = (set, provs) =>
            {
                _providers = provs;
                _loading = true;
                items.Clear();
                foreach (var kv in provs)
                    items.Add(new ProviderItem { Key = kv.Key, Label = GetStr(kv.Value, "label") + "（" + kv.Key + "）" });
                cmb.ItemsSource = null;
                cmb.ItemsSource = items;
                var cur = GetStr(set, "provider");
                // 回填前跳过正在编辑的控件，别把用户没保存的输入冲掉（M30）
                if (!cmb.IsKeyboardFocusWithin) cmb.SelectedItem = items.FirstOrDefault(x => x.Key == cur);
                if (!baseUrl.IsKeyboardFocusWithin) baseUrl.Text = GetStr(set, "baseUrl");
                if (!model.IsKeyboardFocusWithin) model.Text = GetStr(set, "model");
                if (!mock.IsKeyboardFocusWithin) mock.IsChecked = set.ValueKind == JsonValueKind.Object && set.TryGetProperty("mock", out var m) && m.ValueKind == JsonValueKind.True;
                _loading = false;
            };
            return card;
        }

        private Border BuildVisionSection()
        {
            var card = Card("看图（视觉模型）", "给智谱 GLM-4V 的 Key，她才能看图片。", out var body);
            var hint = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 8) };
            var pwd = new PasswordBox();
            body.Children.Add(hint);
            body.Children.Add(BuildField(new FieldSpec { Path = "vision.baseUrl", Label = "看图接口地址", Kind = "text" }));
            body.Children.Add(BuildField(new FieldSpec { Path = "vision.model", Label = "看图模型名", Kind = "text", Hint = "默认 glm-4v-flash（免费）" }));
            body.Children.Add(BuildField(new FieldSpec { Path = "vision.timeoutMs", Label = "看图超时(毫秒)", Kind = "num", Min = 1000, Max = 300000 }));
            body.Children.Add(Row("看图 Key", pwd, "留空表示不改"));
            var buttons = new WrapPanel { Margin = new Thickness(0, 8, 0, 0) };
            var save = new Button { Content = "保存看图 Key", Style = (Style)FindResource("Ghost") };
            var test = new Button { Content = "测一下", Style = (Style)FindResource("Ghost"), Margin = new Thickness(8, 0, 0, 0) };
            var result = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) };
            buttons.Children.Add(save);
            buttons.Children.Add(test);
            body.Children.Add(buttons);
            body.Children.Add(result);

            save.Click += async (s, e) =>
            {
                if (pwd.Password.Trim().Length == 0) { result.Text = "留空就不改。"; return; }
                var res = await Api.Post(_sup.Url, "/api/settings", "{\"visionApiKey\":\"" + Api.Esc(pwd.Password.Trim()) + "\"}");
                result.Text = res.Ok ? "看图 Key 已保存。" : "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
                if (res.Ok) pwd.Password = "";
            };
            test.Click += async (s, e) =>
            {
                result.Text = "正在测…";
                var res = await Api.Post(_sup.Url, "/api/vision/test", "{}");
                result.Text = res.Ok ? "看图通了，它说：" + res.Str("sample") : "没通：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            };

            _loadVision = (set) =>
            {
                var v = set.ValueKind == JsonValueKind.Object && set.TryGetProperty("vision", out var vv) ? vv : default;
                if (v.ValueKind == JsonValueKind.Object)
                {
                    var configured = v.TryGetProperty("configured", out var c) && c.ValueKind == JsonValueKind.True;
                    var masked = v.TryGetProperty("keyMasked", out var km) && km.ValueKind == JsonValueKind.String ? km.GetString() : "";
                    hint.Text = configured ? "已配置：" + masked : "没配置。填一把智谱 GLM-4V 的 Key。";
                }
            };
            return card;
        }

        // ── 读写 ────────────────────────────────────────────────
        /// <summary>
        /// 周期刷新（MainWindow 2 秒定时器驱动）：只更新状态行，不动表单——
        /// 否则会把用户正在编辑的值冲掉，随后 LostFocus 又把旧值写回服务端（M30）。
        /// 全量回填只在页面载入（Loaded）做；表单还没载入过（比如内核后启动）时补一次。
        /// </summary>
        public async Task RefreshAsync()
        {
            if (!_sup.NodeRunning)
            {
                KernelHint.Text = "内核没起，配置项读不到也存不了；外观（主题 / 背景图）仍然可用。点顶栏 ⏻ 启动。";
                _configLoaded = false;
                return;
            }
            KernelHint.Text = "改完立即写回 config.json（密钥留空表示不改）";
            if (!_configLoaded) await LoadConfigAsync();      // 还没回填过，补一次
        }

        /// <summary>全量回填：把服务端的值刷回所有表单控件（跳过正在编辑的）。</summary>
        private async Task LoadConfigAsync()
        {
            if ((DateTime.Now - _lastLoad).TotalSeconds < 5) return;   // 节流：≥5 秒一次（照 SettingsPage 原有做法）
            if (_loadingConfig) return;
            _loadingConfig = true;
            _lastLoad = DateTime.Now;
            try
            {
                var cfg = await Api.Get(_sup.Url, "/api/config");
                if (!cfg.Ok) return;
                var settings = await Api.Get(_sup.Url, "/api/settings");
                var config = cfg.Prop("config");
                _loading = true;
                try
                {
                    foreach (var kv in _loaders)
                        kv.Value(GetPath(config, kv.Key));
                }
                finally { _loading = false; }

                if (settings.Ok)
                {
                    var provs = new Dictionary<string, JsonElement>();
                    var p = settings.Prop("providers");
                    if (p.ValueKind == JsonValueKind.Object)
                        foreach (var it in p.EnumerateObject()) provs[it.Name] = it.Value;
                    _loadModel?.Invoke(settings.Root, provs);
                    _loadVision?.Invoke(settings.Root);
                }
                _configLoaded = true;

                var ver = "4.0";
                var pkg = Path.Combine(AppContext.BaseDirectory, "package.json");
                if (File.Exists(pkg))
                {
                    var m = System.Text.RegularExpressions.Regex.Match(File.ReadAllText(pkg), "\"version\"\\s*:\\s*\"([^\"]+)\"");
                    if (m.Success) ver = m.Groups[1].Value;
                }
                AboutText.Text = "鲸鲸 " + ver + " · 启动器 4.0";
            }
            finally
            {
                _loadingConfig = false;
            }
        }

        private static JsonElement GetPath(JsonElement root, string dotted)
        {
            var cur = root;
            foreach (var part in dotted.Split('.'))
            {
                if (cur.ValueKind != JsonValueKind.Object || !cur.TryGetProperty(part, out var next)) return default;
                cur = next;
            }
            return cur;
        }

        private static string GetStr(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
                ? (v.GetString() ?? "") : "";
    }
}
