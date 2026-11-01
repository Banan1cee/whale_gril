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
        public string Kind = "text";      // bool / num / text / secret / select / multiline / slider / sliderInput
        public string Hint = "";
        public double Min = double.NaN;
        public double Max = double.NaN;
        // sliderInput 专用：右边输入框自己的范围（可以比滑块宽，比如滑块 2000–20000、输入框 1000–不设上限）
        public double InputMin = double.NaN;
        public double InputMax = double.NaN;
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
        public SettingsPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            BuildOnce();
            Loaded += async (_, __) =>
            {
                MainScroll.ScrollToTop();
                await LoadConfigAsync();   // 页面载入才全量回填（M30）
            };
        }

        // ── 全部设置清单（启动器是唯一界面）────────────────────────
        private static List<SectionSpec> Specs() => new List<SectionSpec>
        {
            new SectionSpec { Title = "群聊", Fields =
            {
                new FieldSpec { Path = "group.requireAt", Label = "必须 @ 她才回", Kind = "bool", Hint = "关掉 = 群里不 @ 也会接，但按下面的插话概率抽，不是每条都回" },
                new FieldSpec { Path = "group.freeChat", Label = "允许她自己插话", Kind = "bool", Hint = "开着时没点名的消息也按概率抽一句；@ 她的不受影响" },
                new FieldSpec { Path = "group.freeChatChance", Label = "插话概率", Kind = "num", Min = 0, Max = 1, IsInt = false, Hint = "没点名的消息按这个概率接一句；0.06 = 百分之六，约 16 条回 1 条；填 1 = 每条都回，仍受冷却和每分钟上限约束" },
                new FieldSpec { Path = "group.cooldownSec", Label = "两次回复冷却(秒)", Kind = "num", Min = 0, Max = 3600 },
                new FieldSpec { Path = "group.maxRepliesPerMinute", Label = "每分钟最多回几条", Kind = "slider", Min = 5, Max = 30, Unit = " 条/分钟", Hint = "推荐 10–20 条" },
                new FieldSpec { Path = "group.masterAlwaysReply", Label = "主人在群里说话永远回", Kind = "bool" },
                new FieldSpec { Path = "group.engagedMinutes", Label = "接话后保持参与(分钟)", Kind = "num", Min = 1, Max = 1440 },
                new FieldSpec { Path = "group.silentMinutes", Label = "冷场多久算结束(分钟)", Kind = "num", Min = 1, Max = 10080 },
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
            new SectionSpec { Title = "高级", Note = "改完要重启的项都在这里（对话预算例外，改完立刻生效）；管理员口令也归这一组，平时不用碰。", Fields =
            {
                new FieldSpec { Path = "memory.dialogueBudget", Label = "对话预算(token)", Kind = "sliderInput", Min = 2000, Max = 20000, InputMin = 1000, Hint = "每轮带多少对话内容（不含人设）：默认 5,500 = 记忆 900 + 摘要 900 + 原文 3,200 + 预留 500。滑块 2,000–20,000；右边输入框可以直接填（最低 1,000，不设上限）。模型一次能收的 token 有硬上限（具体值看下面那行），人设越长留给对话的越少；加起来超了内核不会偷偷截断，而是这一轮干脆不调用" },
                new FieldSpec { Path = "server.host", Label = "监听地址", Kind = "text", Hint = "只给本机用就 127.0.0.1；0.0.0.0 = 同 WiFi 也能连（改完重启）" },
                new FieldSpec { Path = "server.port", Label = "本机端口", Kind = "selectnum", Options = new[] { "8787", "9191", "1919", "7878" }, Hint = "默认 8787；只在这四个里选，改完重启内核生效" },
                new FieldSpec { Path = "log.level", Label = "日志级别", Kind = "select", Options = new[] { "debug", "info", "error" }, Hint = "界面 / 控制台用哪一档；日志文件始终记 debug 全量（data/whale.log、data/wechat-bridge-4x.log），改完重启生效" },
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

            AddSection(BuildModelSection());
            AddSection(BuildAdvancedSection());
            AddSection(BuildAppearanceSection());
        }

        /// <summary>卡片直接按顺序堆进单列滚动区。</summary>
        private void AddSection(Border card)
        {
            card.Margin = new Thickness(0, 0, 0, 14);
            SectionsHost.Children.Add(card);
        }

        /// <summary>
        /// 高级模式：四个胶囊页签直接摆出来，点了才展开那一组；再点同一个页签收起。
        /// 没有「展开高级设置」这种中间按钮，少一次点击。
        /// </summary>
        private Border BuildAdvancedSection()
        {
            var card = Card("高级模式", "群聊、微信数据与管道、联网与链接、服务端口。平时不用动，点一下对应页签再改。", out var body);

            var strip = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 0) };
            body.Children.Add(strip);

            var specs = Specs();
            var tabs = new Button[specs.Count];
            var panels = new StackPanel[specs.Count];
            var active = -1;

            void Select(int idx)
            {
                if (active == idx)
                {
                    panels[idx].Visibility = Visibility.Collapsed;
                    MarkTab(tabs[idx], false);
                    active = -1;
                    return;
                }
                for (var i = 0; i < panels.Length; i++)
                {
                    panels[i].Visibility = i == idx ? Visibility.Visible : Visibility.Collapsed;
                    MarkTab(tabs[i], i == idx);
                }
                active = idx;
            }

            for (var i = 0; i < specs.Count; i++)
            {
                var spec = specs[i];
                var tab = MakeTab(spec.Title, out var _);
                var panel = new StackPanel { Visibility = Visibility.Collapsed, Margin = new Thickness(0, 12, 0, 0) };
                if (!string.IsNullOrEmpty(spec.Note))
                    panel.Children.Add(new TextBlock
                    {
                        Text = spec.Note,
                        Style = (Style)FindResource("Small"),
                        TextWrapping = TextWrapping.Wrap,
                        Margin = new Thickness(0, 0, 0, 8),
                    });
                foreach (var f in spec.Fields) panel.Children.Add(BuildField(f));

                // 这一组「恢复默认」：只写回这个页签里的字段，默认值由内核给
                var foot = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) };
                var resetTab = new Button { Content = "这一组恢复默认", Style = (Style)FindResource("Ghost") };
                resetTab.Click += async (s, e) => await ResetFieldsAsync(spec.Title, spec.Fields.Select(f => f.Path));
                foot.Children.Add(resetTab);
                panel.Children.Add(foot);
                tabs[i] = tab;
                panels[i] = panel;
                strip.Children.Add(tab);
                body.Children.Add(panel);
                var idx = i;
                tab.Click += (s, e) => Select(idx);
            }

            return card;
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

        private Grid Row(string label, FrameworkElement control, string hint, bool top = false, double labelWidth = 150)
        {
            var grid = new Grid { Margin = new Thickness(0, 0, 0, 8) };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(labelWidth) });
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
        /// <param name="compact">两列并排时用的紧凑标签列</param>
        /// <param name="width">单独指定标签列宽（不传就按 compact 取默认值）</param>
        private FrameworkElement BuildField(FieldSpec f, bool compact = false, double width = double.NaN)
        {
            // 标签列别太宽：210 的时候标签和输入框中间空出半个屏幕，短标签尤其难看
            var labelWidth = !double.IsNaN(width) ? width : (compact ? 110.0 : 150.0);
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
                    return Row(f.Label, chk, f.Hint, false, labelWidth);
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
                    return Row(f.Label, cmb, f.Hint, false, labelWidth);
                }
                case "selectnum":
                {
                    // 端口这类「只能从固定几项里挑」的数字：下拉显示，写回仍是数字
                    var cmb = new ComboBox { Height = 26, ItemsSource = f.Options, MinWidth = 140, HorizontalAlignment = HorizontalAlignment.Left };
                    cmb.SelectionChanged += async (s, e) =>
                    {
                        if (_loading || cmb.SelectedItem == null) return;
                        await PatchAsync(f.Path, (string)cmb.SelectedItem);
                    };
                    _loaders[f.Path] = v =>
                    {
                        if (cmb.IsKeyboardFocusWithin) return;
                        _loading = true;
                        var cur = v.ValueKind == JsonValueKind.Number ? v.GetInt32().ToString()
                            : (v.ValueKind == JsonValueKind.String ? v.GetString() : null);
                        if (cur != null && (f.Options ?? new string[0]).Contains(cur)) cmb.SelectedItem = cur;
                        _loading = false;
                    };
                    return Row(f.Label, cmb, f.Hint, false, labelWidth);
                }
                case "secret":
                {
                    var pwd = new PasswordBox();
                    pwd.LostFocus += async (s, e) =>
                    {
                        if (_loading || pwd.Password.Length == 0) return;
                        if (await PatchAsync(f.Path, "\"" + Api.Esc(pwd.Password.Trim()) + "\"")) pwd.Password = "";
                    };
                    return Row(f.Label, pwd, f.Hint, false, labelWidth);
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
                    return Row(f.Label, box, f.Hint, false, labelWidth);
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
                    return Row(f.Label, box, f.Hint, false, labelWidth);
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
                    return Row(f.Label, panel, f.Hint, false, labelWidth);
                }
                case "sliderInput":
                {
                    // 滑块管「常用范围」，右边输入框管「精确值 / 超出滑块范围的值」；
                    // 下面那行说明由 /api/budget/estimate 实时算（只读估算，不联网、不花钱）。
                    var slider = new Slider
                    {
                        Minimum = double.IsNaN(f.Min) ? 0 : f.Min,
                        Maximum = double.IsNaN(f.Max) ? 100 : f.Max,
                        TickFrequency = 100,
                        IsSnapToTickEnabled = true,
                        Width = 240,
                        VerticalAlignment = VerticalAlignment.Center
                    };
                    var box = new TextBox
                    {
                        Width = 96,
                        VerticalAlignment = VerticalAlignment.Center,
                        Margin = new Thickness(12, 0, 0, 0),
                        TextAlignment = TextAlignment.Center
                    };
                    var unit = new TextBlock
                    {
                        Text = string.IsNullOrEmpty(f.Unit) ? " token" : f.Unit,
                        Style = (Style)FindResource("Small"),
                        VerticalAlignment = VerticalAlignment.Center,
                        Margin = new Thickness(6, 0, 0, 0)
                    };
                    var line = new TextBlock
                    {
                        Style = (Style)FindResource("Small"),
                        TextWrapping = TextWrapping.Wrap,
                        Margin = new Thickness(0, 6, 0, 0),
                        Text = f.Hint,
                    };
                    var bar = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Left };
                    bar.Children.Add(slider);
                    bar.Children.Add(box);
                    bar.Children.Add(unit);
                    var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Stretch };
                    stack.Children.Add(bar);
                    stack.Children.Add(line);

                    var saveTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(450) };
                    var hintTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(180) };
                    var syncing = false;
                    var saved = double.NaN;

                    double Clamp(double v)
                    {
                        if (!double.IsNaN(f.InputMin)) v = Math.Max(f.InputMin, v);
                        if (!double.IsNaN(f.InputMax)) v = Math.Min(f.InputMax, v);
                        return Math.Round(v);
                    }

                    double Current()
                    {
                        var text = (box.Text ?? "").Trim();
                        return double.TryParse(text, out var v) ? Clamp(v) : Math.Round(slider.Value);
                    }

                    void Show(double v)
                    {
                        syncing = true;
                        slider.Value = Math.Max(slider.Minimum, Math.Min(slider.Maximum, v));
                        if (!box.IsKeyboardFocusWithin) box.Text = Math.Round(v).ToString();
                        syncing = false;
                    }

                    async void RefreshHint(double v)
                    {
                        try
                        {
                            var res = await Api.Get(_sup.Url, "/api/budget/estimate?dialogueBudget=" + Math.Round(v));
                            if (!res.Ok)
                            {
                                line.Text = f.Hint;
                                return;
                            }
                            var sys = res.Long("systemTokens");
                            var sp = res.Long("systemPrivateTokens");
                            var sg = res.Long("systemGroupTokens");
                            var maxIn = res.Long("maxInputTokens");
                            var hard = res.Long("hardTotalTokens");
                            var room = Math.Max(0, hard - sys);
                            var over = res.Bool("overHardLimit");
                            var first = Num(res.Prop("cost"), "idle", "first");
                            var cached = Num(res.Prop("cost"), "idle", "cached");
                            line.Text =
                                $"人设 system ≈ {sys:N0} token（私聊 {sp:N0} / 群聊 {sg:N0}，取中间）+ 对话预算 {Math.Round(v):N0} → 单轮最多 ≈ {maxIn:N0} token（上限 {hard:N0}）\n"
                                + $"谷时：首次约 ¥{first:0.0000}，之后缓存命中约 ¥{cached:0.0000} / 次（人设走缓存，新对话仍按新内容计费）"
                                + (over ? $"\n⚠ 已经超过 {hard:N0} 上限：这个预算下每轮都会被拒绝，最多只能填 {room:N0}" : "");
                        }
                        catch
                        {
                            line.Text = f.Hint;
                        }
                    }

                    void Schedule(bool refreshHint)
                    {
                        if (_loading) return;
                        saveTimer.Stop();
                        saveTimer.Start();
                        if (!refreshHint) return;
                        hintTimer.Stop();
                        hintTimer.Start();
                    }

                    slider.ValueChanged += (s, e) =>
                    {
                        if (syncing || _loading) return;
                        box.Text = Math.Round(slider.Value).ToString();
                        Schedule(true);
                    };

                    box.LostFocus += (s, e) =>
                    {
                        if (syncing || _loading) return;
                        var v = Current();
                        Show(v);
                        Schedule(true);
                    };
                    box.KeyDown += (s, e) =>
                    {
                        if (e.Key == System.Windows.Input.Key.Enter) System.Windows.Input.Keyboard.ClearFocus();
                    };

                    saveTimer.Tick += async (s, e) =>
                    {
                        saveTimer.Stop();
                        var v = Current();
                        if (v.Equals(saved)) return;
                        saved = v;
                        await PatchAsync(f.Path, v.ToString("0"));
                    };

                    hintTimer.Tick += (s, e) =>
                    {
                        hintTimer.Stop();
                        RefreshHint(Current());
                    };

                    _loaders[f.Path] = v =>
                    {
                        if (box.IsKeyboardFocusWithin) return;   // 正在编辑就不覆盖（M30）
                        _loading = true;
                        if (v.ValueKind == JsonValueKind.Number)
                        {
                            var n = v.GetDouble();
                            Show(n);
                            saved = Math.Round(n);
                        }
                        _loading = false;
                        RefreshHint(Current());
                    };

                    return Row(f.Label, stack, "", false, labelWidth);
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
                    return Row(f.Label, box, f.Hint, false, labelWidth);
                }
            }
        }

        /// <summary>按路径从 JSON 里取数字（拿不到就 0），给估算回包的嵌套字段用。</summary>
        private static double Num(JsonElement root, params string[] path)
        {
            var cur = root;
            foreach (var p in path)
            {
                if (cur.ValueKind != JsonValueKind.Object || !cur.TryGetProperty(p, out var next)) return 0;
                cur = next;
            }
            return cur.ValueKind == JsonValueKind.Number ? cur.GetDouble() : 0;
        }

        private async Task<bool> PatchAsync(string path, string jsonLiteral)
        {
            var body = "{\"patch\":{\"" + Api.Esc(path) + "\":" + jsonLiteral + "}}";
            var res = await Api.Post(_sup.Url, "/api/config", body);
            StatusText.Text = res.Ok
                ? path + " 已保存 " + DateTime.Now.ToString("HH:mm:ss")
                : path + " 保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            return res.Ok;
        }

        /// <summary>
        /// 「恢复默认」：把这些字段写回默认值。
        /// 默认值由内核按 DEFAULT_CONFIG 给（启动器不自己抄一份，抄的那份迟早和 config.js 对不上）。
        /// 只动这些字段：API Key 不重置，data\ 里的聊天记忆更不会碰。
        /// </summary>
        private async Task ResetFieldsAsync(string title, IEnumerable<string> paths)
        {
            var list = (paths ?? Enumerable.Empty<string>())
                .Where(p => !string.IsNullOrWhiteSpace(p))
                .Distinct()
                .ToList();
            if (list.Count == 0) return;

            var answer = MessageBox.Show(
                "把「" + title + "」改回默认值？\n\n只改这 " + list.Count + " 项；API Key 和聊天记忆不会被清掉。",
                "恢复默认", MessageBoxButton.YesNo, MessageBoxImage.Question);
            if (answer != MessageBoxResult.Yes) return;

            var body = "{\"paths\":[" + string.Join(",", list.Select(p => "\"" + Api.Esc(p) + "\"")) + "]}";
            var res = await Api.Post(_sup.Url, "/api/config/reset", body);
            if (!res.Ok)
            {
                StatusText.Text = "恢复默认失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
                return;
            }

            var unknown = res.Prop("unknown");
            var missed = unknown.ValueKind == JsonValueKind.Array ? unknown.GetArrayLength() : 0;
            StatusText.Text = "「" + title + "」已恢复默认（" + list.Count + " 项）"
                + (missed > 0 ? "，其中 " + missed + " 项不是可恢复项" : "");
            _lastLoad = DateTime.MinValue;   // 绕过节流，立刻把默认值刷回表单
            await LoadConfigAsync();
        }

        // ── 模型 / 看图（一张卡，两组用页签切换）────────────────────
        private const string AutoVision = "自动（跟随聊天模型）";

        /// <summary>模型卡片里的标签都短，标签列收到 110 就够；再宽就是白条。</summary>
        private const double ModelLabel = 110;

        private Button MakeTab(string text, out TextBlock badge)
        {
            badge = new TextBlock { FontSize = 10, Margin = new Thickness(6, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            badge.SetResourceReference(TextBlock.ForegroundProperty, "Dim");
            var stack = new StackPanel { Orientation = Orientation.Horizontal };
            stack.Children.Add(new TextBlock { Text = text, VerticalAlignment = VerticalAlignment.Center });
            stack.Children.Add(badge);
            return new Button
            {
                Height = 30,
                Padding = new Thickness(12, 0, 12, 0),
                Margin = new Thickness(0, 0, 6, 0),
                BorderThickness = new Thickness(1),
                Cursor = System.Windows.Input.Cursors.Hand,
                FocusVisualStyle = null,
                Content = stack,
                Style = (Style)FindResource("Ghost"),
            };
        }

        private static void MarkTab(Button btn, bool active)
        {
            btn.SetResourceReference(Button.BackgroundProperty, active ? "AccentSoft" : "Transparent");
            btn.SetResourceReference(Button.BorderBrushProperty, active ? "Accent" : "Line");
            btn.SetResourceReference(Button.ForegroundProperty, active ? "Accent" : "Muted");
            btn.FontWeight = active ? FontWeights.SemiBold : FontWeights.Normal;
        }

        /// <summary>
        /// 两列并排；right 为空时只占左半列。
        /// 左列定宽而不是各占一半：字段本身只有一百多像素宽，平均分两半会让右列
        /// 孤零零飘在卡片正中间，左边空出一大块（4.0 的采样区就是这样）。
        /// </summary>
        private static FrameworkElement TwoCol(FrameworkElement left, FrameworkElement right)
        {
            var g = new Grid();
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(330) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.Children.Add(left);
            if (right != null)
            {
                Grid.SetColumn(right, 2);
                g.Children.Add(right);
            }
            return g;
        }

        private Border BuildModelSection()
        {
            var card = Card("模型", "聊天、看图、语音分三页签。聊天模型自己能看图时，看图模型自动跟随；手动指定过就以手动为准。", out var body);

            var chatTab = MakeTab("聊天（文本）", out var chatBadge);
            var visionTab = MakeTab("看图（视觉）", out var visionBadge);
            var voiceTab = MakeTab("语音", out var voiceBadge);
            var strip = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 14) };
            strip.Children.Add(chatTab);
            strip.Children.Add(visionTab);
            strip.Children.Add(voiceTab);
            body.Children.Add(strip);

            var chatPanel = new StackPanel();
            var visionPanel = new StackPanel { Visibility = Visibility.Collapsed };
            var voicePanel = new StackPanel { Visibility = Visibility.Collapsed };
            body.Children.Add(chatPanel);
            body.Children.Add(visionPanel);
            body.Children.Add(voicePanel);

            var tabs = new[] { chatTab, visionTab, voiceTab };
            var panels = new[] { chatPanel, visionPanel, voicePanel };
            void SelectTab(int idx)
            {
                for (var i = 0; i < panels.Length; i++)
                {
                    panels[i].Visibility = i == idx ? Visibility.Visible : Visibility.Collapsed;
                    MarkTab(tabs[i], i == idx);
                }
            }
            chatTab.Click += (s, e) => SelectTab(0);
            visionTab.Click += (s, e) => SelectTab(1);
            voiceTab.Click += (s, e) => SelectTab(2);
            SelectTab(0);

            // 两组控件先都建出来：换聊天模型时要同步刷新看图的提示和角标
            var items = new List<ProviderItem>();
            var cmb = new ComboBox { Height = 28, DisplayMemberPath = "Label", MinWidth = 320, HorizontalAlignment = HorizontalAlignment.Left };
            var baseUrl = new TextBox();
            var model = new ComboBox { Height = 28, IsEditable = true, MinWidth = 320, HorizontalAlignment = HorizontalAlignment.Left };
            var key = new PasswordBox();
            var mock = new CheckBox();
            var chatResult = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) };

            var visionModel = new ComboBox { Height = 28, MinWidth = 320, HorizontalAlignment = HorizontalAlignment.Left };
            var visionTip = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 3, 0, 0) };
            var visionBox = new StackPanel();
            visionBox.Children.Add(visionModel);
            visionBox.Children.Add(visionTip);
            var visionKey = new PasswordBox();
            var visionHint = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 8) };
            var visionEndpoint = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 8) };
            var visionResult = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) };

            void FillOptions(JsonElement pv)
            {
                var chat = new List<string>();
                var sight = new List<string> { AutoVision };
                if (pv.ValueKind == JsonValueKind.Object)
                {
                    if (pv.TryGetProperty("models", out var arr) && arr.ValueKind == JsonValueKind.Array)
                        foreach (var it in arr.EnumerateArray())
                            if (it.ValueKind == JsonValueKind.String) chat.Add(it.GetString());
                    if (pv.TryGetProperty("visionModels", out var varr) && varr.ValueKind == JsonValueKind.Array)
                        foreach (var it in varr.EnumerateArray())
                            if (it.ValueKind == JsonValueKind.String) sight.Add(it.GetString());
                }
                model.ItemsSource = chat;
                var keep = visionModel.SelectedItem as string;
                visionModel.ItemsSource = sight;
                if (keep != null && sight.Contains(keep)) visionModel.SelectedItem = keep;
                else visionModel.SelectedItem = AutoVision;   // 换服务商后原来的钉值不在了，回自动
            }

            void SyncVisionToChat()
            {
                var picked = model.SelectedItem as string ?? model.Text;
                var capable = false;
                if (visionModel.ItemsSource is List<string> sight && !string.IsNullOrWhiteSpace(picked))
                {
                    foreach (var s in sight)
                        if (s == picked && s != AutoVision) { capable = true; break; }
                }
                var sel = visionModel.SelectedItem as string ?? AutoVision;
                if (sel == AutoVision)
                {
                    visionTip.Text = capable
                        ? "自动跟随聊天模型：" + picked
                        : "自动：聊天模型不能看图时用默认视觉模型（glm-4.6v-flash）";
                    visionBadge.Text = capable ? "跟随中" : "";
                }
                else
                {
                    visionTip.Text = "已手动指定：" + sel + "（换聊天模型不会覆盖）";
                    visionBadge.Text = "已指定";
                }
                chatBadge.Text = model.Text.Trim().Length > 0 ? "" : "";
            }

            cmb.SelectionChanged += (s, e) =>
            {
                if (_loading || !(cmb.SelectedItem is ProviderItem p)) return;
                if (_providers != null && _providers.TryGetValue(p.Key, out var pv))
                {
                    baseUrl.Text = GetStr(pv, "baseUrl");
                    FillOptions(pv);
                    model.Text = GetStr(pv, "model");
                    SyncVisionToChat();
                }
            };
            model.SelectionChanged += (s, e) => { if (!_loading) SyncVisionToChat(); };
            visionModel.SelectionChanged += (s, e) => { if (!_loading) SyncVisionToChat(); };

            // ── 聊天面板 ────────────────────────────────────────
            chatPanel.Children.Add(Row("模型服务", cmb, "", false, ModelLabel));
            chatPanel.Children.Add(Row("接口地址", baseUrl, "", false, ModelLabel));
            chatPanel.Children.Add(Row("模型名", model, "点下拉直接选；没有的型号也可以自己输入", false, ModelLabel));
            chatPanel.Children.Add(Row("API Key", key, "留空表示不改；已存的这里不会显示", false, ModelLabel));
            chatPanel.Children.Add(Row("演示模式", mock, "不连模型，用内置台词", false, ModelLabel));

            var chatDivider = new Border { Height = 1, Margin = new Thickness(0, 4, 0, 12) };
            chatDivider.SetResourceReference(Border.BackgroundProperty, "Line");
            chatPanel.Children.Add(chatDivider);
            chatPanel.Children.Add(new TextBlock { Text = "采样", Style = (Style)FindResource("Label"), Margin = new Thickness(0, 0, 0, 8) });
            chatPanel.Children.Add(TwoCol(
                BuildField(new FieldSpec { Path = "deepseek.temperature", Label = "温度", Kind = "num", Min = 0, Max = 2, IsInt = false, Hint = "越大越放得开（>1.2 容易跑偏）" }, true),
                BuildField(new FieldSpec { Path = "deepseek.maxTokens", Label = "最多 token", Kind = "num", Min = 16, Max = 32768, Hint = "默认 700" }, true)));
            chatPanel.Children.Add(TwoCol(
                BuildField(new FieldSpec { Path = "deepseek.frequencyPenalty", Label = "频率惩罚", Kind = "num", Min = -2, Max = 2, IsInt = false }, true),
                BuildField(new FieldSpec { Path = "deepseek.presencePenalty", Label = "在场惩罚", Kind = "num", Min = -2, Max = 2, IsInt = false }, true)));
            chatPanel.Children.Add(TwoCol(
                BuildField(new FieldSpec { Path = "deepseek.timeoutMs", Label = "请求超时(ms)", Kind = "num", Min = 1000, Max = 600000 }, true),
                null));

            var chatButtons = new WrapPanel { Margin = new Thickness(0, 6, 0, 0) };
            var save = new Button { Content = "保存", Style = (Style)FindResource("Primary") };
            var test = new Button { Content = "测试连通", Style = (Style)FindResource("Ghost"), Margin = new Thickness(8, 0, 0, 0) };
            var resetSampling = new Button { Content = "采样恢复默认", Style = (Style)FindResource("Ghost"), Margin = new Thickness(8, 0, 0, 0) };
            resetSampling.Click += async (s, e) => await ResetFieldsAsync("采样参数", new[]
            {
                "deepseek.temperature", "deepseek.maxTokens",
                "deepseek.frequencyPenalty", "deepseek.presencePenalty",
                "deepseek.timeoutMs",
            });
            chatButtons.Children.Add(save);
            chatButtons.Children.Add(test);
            chatButtons.Children.Add(resetSampling);
            chatPanel.Children.Add(chatButtons);
            chatPanel.Children.Add(chatResult);

            string ModelRequest()
            {
                var prov = (cmb.SelectedItem as ProviderItem)?.Key ?? "";
                var vm = visionModel.SelectedItem as string ?? AutoVision;
                if (vm == AutoVision) vm = "";
                return "{"
                    + "\"provider\":\"" + Api.Esc(prov) + "\","
                    + "\"baseUrl\":\"" + Api.Esc(baseUrl.Text.Trim()) + "\","
                    + "\"model\":\"" + Api.Esc(model.Text.Trim()) + "\","
                    + "\"visionModel\":\"" + Api.Esc(vm) + "\","
                    + "\"mock\":" + (mock.IsChecked == true ? "true" : "false")
                    + (key.Password.Length > 0 ? ",\"apiKey\":\"" + Api.Esc(key.Password.Trim()) + "\"" : "")
                    + "}";
            }

            save.Click += async (s, e) =>
            {
                var res = await Api.Post(_sup.Url, "/api/settings", ModelRequest());
                if (!res.Ok) { chatResult.Text = "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw); return; }
                key.Password = "";
                chatResult.Text = "已保存。";
            };
            test.Click += async (s, e) =>
            {
                chatResult.Text = "正在测…";
                var res = await Api.Post(_sup.Url, "/api/settings/test", ModelRequest());
                chatResult.Text = res.Ok ? "连通正常。" : "测试没通过：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            };

            // ── 看图面板 ────────────────────────────────────────
            visionPanel.Children.Add(visionHint);
            visionPanel.Children.Add(Row("看图模型", visionBox, "", false, ModelLabel));
            visionPanel.Children.Add(visionEndpoint);
            // 这一行别用 compact：同页另外两行是 ModelLabel 的标签列，窄了会让输入框缩进去一截（错位）
            visionPanel.Children.Add(BuildField(new FieldSpec { Path = "vision.timeoutMs", Label = "超时(毫秒)", Kind = "num", Min = 1000, Max = 300000 }, false, ModelLabel));
            visionPanel.Children.Add(Row("看图 Key", visionKey, "留空表示不改", false, ModelLabel));

            var visionButtons = new WrapPanel { Margin = new Thickness(0, 6, 0, 0) };
            var vsave = new Button { Content = "保存看图 Key", Style = (Style)FindResource("Ghost") };
            var vtest = new Button { Content = "测一下", Style = (Style)FindResource("Ghost"), Margin = new Thickness(8, 0, 0, 0) };
            visionButtons.Children.Add(vsave);
            visionButtons.Children.Add(vtest);
            visionPanel.Children.Add(visionButtons);
            visionPanel.Children.Add(visionResult);

            vsave.Click += async (s, e) =>
            {
                if (visionKey.Password.Trim().Length == 0) { visionResult.Text = "留空就不改。"; return; }
                var res = await Api.Post(_sup.Url, "/api/settings", "{\"visionApiKey\":\"" + Api.Esc(visionKey.Password.Trim()) + "\"}");
                visionResult.Text = res.Ok ? "看图 Key 已保存。" : "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
                if (res.Ok) visionKey.Password = "";
            };
            vtest.Click += async (s, e) =>
            {
                visionResult.Text = "正在测…";
                var res = await Api.Post(_sup.Url, "/api/vision/test", "{}");
                visionResult.Text = res.Ok ? "看图通了，它说：" + res.Str("sample") : "没通：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            };

            // ── 语音面板（原来单独一页，并到模型卡里）──────────
            var voiceHint = new TextBlock
            {
                Style = (Style)FindResource("Small"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 8),
                Text = "别人发语音时先转成文字再回复；Key 留空则沿用主模型那把。",
            };
            voicePanel.Children.Add(voiceHint);
            voicePanel.Children.Add(BuildField(new FieldSpec { Path = "voice.enabled", Label = "语音回复", Kind = "bool" }, false, ModelLabel));
            voicePanel.Children.Add(BuildField(new FieldSpec { Path = "voice.apiKey", Label = "语音接口 Key", Kind = "secret", Hint = "留空表示不改；留空则用主模型的 Key" }, false, ModelLabel));
            voicePanel.Children.Add(BuildField(new FieldSpec { Path = "voice.baseUrl", Label = "接口地址", Kind = "text" }, false, ModelLabel));
            voicePanel.Children.Add(BuildField(new FieldSpec { Path = "voice.model", Label = "语音模型", Kind = "text" }, false, ModelLabel));
            voicePanel.Children.Add(TwoCol(
                BuildField(new FieldSpec { Path = "voice.timeoutMs", Label = "识别超时(ms)", Kind = "num", Min = 1000, Max = 300000 }, true),
                BuildField(new FieldSpec { Path = "voice.maxSeconds", Label = "最长语音(秒)", Kind = "num", Min = 1, Max = 600 }, true)));

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
                if (!cmb.IsKeyboardFocusWithin) cmb.SelectedItem = items.FirstOrDefault(x => x.Key == cur);
                var picked = items.FirstOrDefault(x => x.Key == cur);
                FillOptions(picked != null && provs.TryGetValue(picked.Key, out var pv) ? pv : default);
                if (!baseUrl.IsKeyboardFocusWithin) baseUrl.Text = GetStr(set, "baseUrl");
                if (!model.IsKeyboardFocusWithin) model.Text = GetStr(set, "model");
                var vis = set.ValueKind == JsonValueKind.Object && set.TryGetProperty("vision", out var vv) ? vv : default;
                var vmodel = GetStr(vis, "model");
                var manual = vis.ValueKind == JsonValueKind.Object && vis.TryGetProperty("manual", out var mf) && mf.ValueKind == JsonValueKind.True;
                if (!visionModel.IsKeyboardFocusWithin)
                {
                    if (manual && vmodel.Length > 0)
                    {
                        var sight = visionModel.ItemsSource as List<string> ?? new List<string>();
                        if (!sight.Contains(vmodel)) { sight.Add(vmodel); visionModel.ItemsSource = null; visionModel.ItemsSource = sight; }
                        visionModel.SelectedItem = vmodel;
                    }
                    else if (visionModel.ItemsSource is List<string> list2 && list2.Contains(AutoVision))
                        visionModel.SelectedItem = AutoVision;
                }
                if (!mock.IsKeyboardFocusWithin) mock.IsChecked = set.ValueKind == JsonValueKind.Object && set.TryGetProperty("mock", out var m) && m.ValueKind == JsonValueKind.True;
                SyncVisionToChat();
                _loading = false;
            };

            _loadVision = (set) =>
            {
                var v = set.ValueKind == JsonValueKind.Object && set.TryGetProperty("vision", out var vv) ? vv : default;
                var curModel = GetStr(v, "model");
                var manual = v.ValueKind == JsonValueKind.Object && v.TryGetProperty("manual", out var mf) && mf.ValueKind == JsonValueKind.True;
                if (v.ValueKind == JsonValueKind.Object)
                {
                    var configured = v.TryGetProperty("configured", out var c) && c.ValueKind == JsonValueKind.True;
                    var masked = v.TryGetProperty("keyMasked", out var km) && km.ValueKind == JsonValueKind.String ? km.GetString() : "";
                    var follow = manual ? "" : "（自动跟随聊天模型）";
                    visionHint.Text = (configured ? "已配置：" + masked : "没配置。可以填一把智谱 Key，也可以让聊天模型跟随它自带看图。")
                        + (curModel.Length > 0 ? " 当前看图模型：" + curModel + follow : "");
                    var ep = GetStr(v, "baseUrl");
                    visionEndpoint.Text = ep.Length > 0 ? "接口地址：" + ep + (manual ? "（手动指定）" : "（自动跟随聊天模型）") : "";
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

