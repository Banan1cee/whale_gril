using System;
using System.Collections.Generic;
using System.IO;
using System.Diagnostics;
using System.Globalization;
using System.Threading;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace WhaleLauncher.Views
{
    public partial class StickerPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly List<(string Key, string Label)> _emotions = new List<(string, string)>();
        private string _current = "";
        private bool _loading;
        private bool _loaded;
        private readonly SemaphoreSlim _refreshLock = new(1);
        private ApiResult _inventory = new();
        private DateTime _nextRefresh;
        private CancellationTokenSource _preview = new();
        private string _librarySignature = "";
        private bool _currentIsExtra;

        public StickerPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            Loaded += async (_, __) => await RefreshAsync();
        }

        public async Task RefreshAsync()
        {
            if (DateTime.UtcNow < _nextRefresh || _refreshLock.CurrentCount == 0) return;
            await LoadAsync();
        }

        private async Task LoadAsync()
        {
            await _refreshLock.WaitAsync();
            try
            {
                _nextRefresh = DateTime.UtcNow.AddSeconds(5);
                await LoadCoreAsync();
            }
            finally { _refreshLock.Release(); }
        }

        private async Task LoadCoreAsync()
        {
            var online = _sup.NodeRunning;
            ChkEnabled.IsEnabled = TxtDir.IsEnabled = online;
            var res = await StickerLibrary.Call(_sup.BaseDir, "inventory");
            if (!res.Ok)
            {
                StatusText.Text = "无法读取图库：" + res.Error;
                return;
            }

            _inventory = res;
            _loading = true;
            ChkEnabled.IsChecked = res.Bool("enabled");
            var chanceEl = res.Prop("demandChance");
            var chance = chanceEl.ValueKind == JsonValueKind.Number && chanceEl.TryGetDouble(out var parsed) ? parsed : 0.7;
            SldDemand.Value = Math.Round(Math.Clamp(chance, 0, 1) * 100);
            ChkEnsure.IsChecked = res.Bool("ensureSend");
            _loading = false;
            TxtDemandValue.Text = Math.Round(SldDemand.Value) + "%";
            var frequencyEnabled = online && res.Bool("enabled");
            SldDemand.IsEnabled = ChkEnsure.IsEnabled = BtnSaveDemand.IsEnabled = frequencyEnabled;
            DemandHint.Opacity = frequencyEnabled ? 1 : 0.55;

            _emotions.Clear();
            var arr = res.Prop("emotions");
            if (arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var e in arr.EnumerateArray())
                    _emotions.Add((S(e, "key"), S(e, "label")));
            }
            if (_current.Length == 0 || !_emotions.Any(x => x.Key == _current))
                _current = _emotions.Count > 0 ? _emotions[0].Key : "";

            var signature = _current + ":" + res.Prop("emotions").GetRawText();
            if (!_loaded || signature != _librarySignature)
            {
                BuildTabs();
                RenderGrid(res);
                _librarySignature = signature;
            }
            DirHint.Text = "目录：" + res.Str("dir");
            if (string.IsNullOrWhiteSpace(TxtTestChat.Text)) TxtTestChat.Text = res.Str("testChat");

            if (!TxtDir.IsKeyboardFocusWithin) TxtDir.Text = res.Str("configuredDir");
            if (!_loaded) StatusText.Text = "选一个分类，打开文件夹，把图片拖进去即可。";
            _loaded = true;
            var queue = online && res.Bool("enabled")
                ? await Api.Get(_sup.Url, "/api/stickers/status?queueOnly=1")
                : new ApiResult();
            var pending = queue.Long("pending");
            QueueInfo.Text = !online ? "内核未启动" : !res.Bool("enabled") ? "发送已关闭"
                : !queue.Ok ? "暂时无法读取发送队列" : pending > 0 ? $"排队中 {pending} 张" : "队列空";
            RenderJobs(queue);
        }

        private async void OnSaveStickerSettings(object sender, RoutedEventArgs e)
        {
            if (_loading || !_sup.NodeRunning || TxtDir.Text.Trim() == _inventory.Str("configuredDir")) return;
            var body = "{\"patch\":{"
                + "\"sticker.dir\":\"" + Api.Esc(TxtDir.Text.Trim()) + "\""
                + "}}";
            var res = await Api.Post(_sup.Url, "/api/config", body);
            StatusText.Text = res.Ok
                ? "表情包设置已保存 · " + DateTime.Now.ToString("HH:mm:ss")
                : "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
        }

        private void OnDemandChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            if (TxtDemandValue == null) return;
            TxtDemandValue.Text = Math.Round(e.NewValue) + "%";
            if (DemandHint == null) return;
            DemandHint.Text = e.NewValue >= 99.5
                ? "100% = 每轮都提醒；只开提醒时模型仍可能不发。要真的每轮都发，请勾选「没写标记也补一张（必发）」。"
                : "0 = 只靠模型自觉；70% ≈ 一半多轮次提醒；100% = 每轮都提醒。勾选「必发」后，命中轮次即使模型没写标记也会补一张（难过/求助除外）。";
        }

        private async void OnSaveDemand(object sender, RoutedEventArgs e)
        {
            if (_loading || !_sup.NodeRunning) return;
            var chance = Math.Round(Math.Clamp(SldDemand.Value / 100.0, 0, 1), 2);
            var ensure = ChkEnsure.IsChecked == true;
            var body = "{\"patch\":{"
                + "\"sticker.demandChance\":" + chance.ToString("0.##", CultureInfo.InvariantCulture)
                + ",\"sticker.ensureSend\":" + (ensure ? "true" : "false")
                + "}}";
            var res = await Api.Post(_sup.Url, "/api/config", body);
            StatusText.Text = res.Ok
                ? $"表情包频率已保存：{Math.Round(chance * 100)}%" + (ensure ? "，必发已开" : "") + " · " + DateTime.Now.ToString("HH:mm:ss")
                : "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            if (res.Ok) await LoadAsync();
        }

        private void BuildTabs()
        {
            Tabs.Children.Clear();
            _currentIsExtra = _current.StartsWith("x:");
            BtnDelCat.Visibility = _currentIsExtra ? Visibility.Visible : Visibility.Collapsed;
            foreach (var (key, label) in _emotions)
            {
                var btn = new Button
                {
                    Content = label,
                    Height = 28,
                    Padding = new Thickness(14, 0, 14, 0),
                    Margin = new Thickness(0, 0, 6, 0),
                    Style = (Style)FindResource(key == _current ? "Primary" : "Ghost"),
                    Tag = key
                };
                btn.Click += (s, e) =>
                {
                    _current = (string)((Button)s).Tag;
                    BuildTabs();
                    RenderGrid(_inventory);
                    _librarySignature = _current + ":" + _inventory.Prop("emotions").GetRawText();
                };
                Tabs.Children.Add(btn);
            }
        }

        private async void RenderGrid(ApiResult res)
        {
            _preview.Cancel();
            _preview.Dispose();
            _preview = new CancellationTokenSource();
            var token = _preview.Token;
            GridHost.Children.Clear();
            var emotion = res.Prop("emotions");
            if (emotion.ValueKind != JsonValueKind.Array) return;
            var selected = _current;
            var category = emotion.EnumerateArray().FirstOrDefault(e => S(e, "key") == selected);
            var items = category.ValueKind == JsonValueKind.Object && category.TryGetProperty("items", out var list)
                ? list : default;
            EmptyHint.Text = "这个分类还是空的。点「打开分类文件夹」，把 GIF / PNG / JPG / WebP 拖进去。";
            EmptyHint.Visibility = items.ValueKind == JsonValueKind.Array && items.GetArrayLength() > 0
                ? Visibility.Collapsed : Visibility.Visible;
            if (items.ValueKind != JsonValueKind.Array) return;

            foreach (var item in items.EnumerateArray())
            {
                var path = S(item, "path");
                var bitmap = await Task.Run(() => ReadThumbnail(path, token));
                if (token.IsCancellationRequested) return;
                GridHost.Children.Add(BuildCell(selected, S(item, "id"), bitmap));
            }
        }

        private static BitmapImage ReadThumbnail(string path, CancellationToken token)
        {
            if (token.IsCancellationRequested) return null;
            try
            {
                using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                var image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.DecodePixelWidth = 160;
                image.StreamSource = stream;
                image.EndInit();
                image.Freeze();
                return image;
            }
            catch (Exception) { return null; }
        }

        private FrameworkElement BuildCell(string category, string name, BitmapImage bitmap)
        {
            var border = new Border
            {
                Width = 120, Height = 120, Margin = new Thickness(0, 0, 10, 10),
                CornerRadius = new CornerRadius(8), ClipToBounds = true, ToolTip = name
            };
            border.SetResourceReference(Border.BackgroundProperty, "Surface3");
            var grid = new Grid();
            if (bitmap != null) grid.Children.Add(new Image { Source = bitmap, Stretch = Stretch.UniformToFill });
            else grid.Children.Add(new TextBlock
            {
                Text = "无法预览", Foreground = (Brush)FindResource("Muted"),
                HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center
            });

            var del = new Button
            {
                Content = "删",
                Width = 26,
                Height = 22,
                FontSize = 11,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Top,
                Margin = new Thickness(0, 4, 4, 0),
                Style = (Style)FindResource("Ghost"),
                Opacity = 0.85,
                Tag = name
            };
            del.Click += async (s, e) =>
            {
                if (!CanManageOnline()) return;
                var n = (string)((Button)s).Tag;
                var confirm = MessageBox.Show($"删掉这张？\n\n{n}", "表情包", MessageBoxButton.OKCancel, MessageBoxImage.Question);
                if (confirm != MessageBoxResult.OK) return;
                var r = await Api.Post(_sup.Url, "/api/stickers/delete",
                    $"{{\"emotion\":\"{Api.Esc(category)}\",\"name\":\"{Api.Esc(n)}\"}}");
                StatusText.Text = r.Ok ? "已删除 " + n : "删除失败：" + (r.Error.Length > 0 ? r.Error : r.Raw);
                if (r.Ok) await LoadAsync();
            };
            grid.Children.Add(del);

            border.Child = grid;
            return border;
        }


        private void RenderJobs(ApiResult res)
        {
            JobsHost.Children.Clear();
            var arr = res.Prop("jobs");
            if (arr.ValueKind != JsonValueKind.Array) return;
            var shown = 0;
            foreach (var j in arr.EnumerateArray())
            {
                var status = S(j, "status");
                var chat = S(j, "chat");
                var file = S(j, "filename");
                var err = FriendlyError(S(j, "error"));
                var when = status switch
                {
                    "confirmed" => "已确认送达",
                    "unconfirmed" => "未确认，请勿重复发送",
                    "cancelled" => "已取消",
                    "sent" or "done" => "已发出",
                    "failed" => "失败",
                    "claimed" or "sending" => "正在发",
                    "reserved" or "queued" or "pending" => "排队中",
                    "expired" => "过期",
                    _ => status
                };
                var line = new TextBlock
                {
                    Text = $"{when} · {chat} · {file}" + (string.IsNullOrEmpty(err) ? "" : "（" + err + "）"),
                    Style = (Style)FindResource("Small"),
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(0, 1, 0, 0)
                };
                JobsHost.Children.Add(line);
                shown++;
                if (shown >= 6) break;
            }
            if (shown == 0) return;
            JobsHost.Children.Insert(0, new TextBlock
            {
                Text = "真实消息测试（最近几条）",
                Style = (Style)FindResource("Label"),
                Margin = new Thickness(0, 0, 0, 3)
            });
        }

        private async void OnAddCategory(object sender, RoutedEventArgs e)
        {
            if (!CanManageOnline()) return;
            var label = (TxtNewCat.Text ?? "").Trim();
            if (label.Length == 0)
            {
                StatusText.Text = "先写一个分类名，比如「猫猫」。文件夹会用同一个名字建出来。";
                return;
            }
            var res = await Api.Post(_sup.Url, "/api/stickers/category",
                "{\"action\":\"add\",\"label\":\"" + Api.Esc(label) + "\"}");
            StatusText.Text = res.Ok ? "已新增分类：" + label : "新增失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            if (res.Ok)
            {
                TxtNewCat.Text = "";
                _current = "x:" + label;
                await LoadAsync();
            }
        }

        private async void OnDeleteCategory(object sender, RoutedEventArgs e)
        {
            if (!_current.StartsWith("x:") || !CanManageOnline()) return;
            var label = _current.Substring(2);
            var confirm = MessageBox.Show(
                "从列表里移除分类「" + label + "」？\n\n文件夹和里面的图片都会保留，随时可以再加回来。",
                "表情包分类", MessageBoxButton.OKCancel, MessageBoxImage.Question);
            if (confirm != MessageBoxResult.OK) return;
            var res = await Api.Post(_sup.Url, "/api/stickers/category",
                "{\"action\":\"remove\",\"label\":\"" + Api.Esc(label) + "\"}");
            StatusText.Text = res.Ok ? "已移除分类：" + label : "移除失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            if (res.Ok)
            {
                _current = "";
                await LoadAsync();
            }
        }

        // ── 动作 ────────────────────────────────────────────────
        private async void OnToggleEnabled(object sender, RoutedEventArgs e)
        {
            if (_loading || !_sup.NodeRunning) return;
            var on = ChkEnabled.IsChecked == true;
            var res = await Api.Post(_sup.Url, "/api/features", $"{{\"key\":\"stickers\",\"value\":{(on ? "true" : "false")}}}");
            StatusText.Text = res.Ok ? $"表情包已{(on ? "开启" : "关闭")}" : "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            _loaded = false;
            await LoadAsync();
        }

        private bool CanManageOnline()
        {
            if (_sup.NodeRunning && ChkEnabled.IsChecked == true) return true;
            StatusText.Text = "这项操作需要启动内核并启用表情包。也可以直接在分类文件夹管理图片。";
            return false;
        }

        private async void OnTestSend(object sender, RoutedEventArgs e)
        {
            if (string.IsNullOrEmpty(_current) || !CanManageOnline()) return;
            var chat = (TxtTestChat.Text ?? "").Trim();
            var body = "{\"emotion\":\"" + Api.Esc(_current) + "\""
                + (chat.Length > 0 ? ",\"chat\":\"" + Api.Esc(chat) + "\"" : "") + "}";
            var res = await Api.Post(_sup.Url, "/api/stickers/test", body);
            QueueInfo.Text = res.Ok ? "已排队 1 张" : "排队失败";
            StatusText.Text = res.Ok
                ? "已排队，接收会话：" + (chat.Length > 0 ? chat : "（配置里的默认会话）")
                  + "。桥接会核验目标，必要时短暂切换微信；以任务结果为准。"
                : "排队失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
        }

        private async void OnOpenFolder(object sender, RoutedEventArgs e)
        {
            var res = await StickerLibrary.Call(_sup.BaseDir, "open", _current);
            if (!res.Ok)
            {
                StatusText.Text = "打开失败：" + res.Error;
                return;
            }
            try
            {
                var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"))
                {
                    UseShellExecute = false
                };
                start.ArgumentList.Add(res.Str("dir"));
                using var explorer = Process.Start(start);
                StatusText.Text = "把图片拖进已打开的文件夹。图库会自动刷新。";
            }
            catch (Exception ex) { StatusText.Text = "无法打开资源管理器：" + ex.Message; }
        }

        private async void OnReload(object sender, RoutedEventArgs e)
        {
            _loaded = false;
            await LoadAsync();
        }

        private static string FriendlyError(string error) => error switch
        {
            "target account window could not be verified" => "无法核验微信账号窗口，请确认微信已登录并选对账号，再重启桥接",
            "window driver is not ready" => "微信窗口驱动尚未就绪，请等待桥接初始化",
            "UIA target proof is unavailable; no OCR fallback" => "微信窗口控件不可读取，请查看诊断，必要时重开微信后重启桥接",
            "sticker job was not claimed; nothing was sent" => "未能领取任务，本次未发送",
            "an uncertain attachment draft must be cleared manually before further sends" => "上次发送可能留下附件草稿，请先在微信中手动清空输入框",
            "could not bring the WeChat window to the foreground" => "无法切到微信窗口，请确认窗口可正常打开",
            _ => error
        };

        private static string S(JsonElement e, string n)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";
    }
}
