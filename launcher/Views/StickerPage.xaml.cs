using System;
using System.Collections.Generic;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace WhaleLauncher.Views
{
    public partial class StickerPage : UserControl, IRefreshable
    {
        // 格子 120px + DPI 余量。160 时单张解码量比 132 多 47%，肉眼分不出。
        private const int ThumbWidth = 132;
        private const int DecodeConcurrency = 4;   // 同时解码 4 张，别再串行排队
        private const int ThumbCacheMax = 800;     // 缩略图内存缓存上限（每张约 70-100 KB）

        private sealed class CellVm
        {
            public string Id = "";
            public string Name = "";
            public string Path = "";
            public long Version;
        }

        private sealed class EmotionVm
        {
            public string Key = "";
            public string Label = "";
            public bool Extra;
            public List<CellVm> Items = new();
        }

        private readonly RuntimeSupervisor _sup;
        private readonly List<EmotionVm> _emotions = new();
        private string _current = "";
        private bool _loading;
        private bool _loaded;
        private readonly SemaphoreSlim _refreshLock = new(1);
        private bool _refreshPending;          // 上一轮还没跑完时点的刷新，跑完补一次
        private ApiResult _inventory = new();
        private DateTime _nextRefresh;
        private CancellationTokenSource _preview = new();
        private string _renderedSignature = "";
        private bool _currentIsExtra;
        private string _libraryDir = "";   // 库根绝对路径（内核给 / 本地库存给），离线开文件夹用
        // 缩略图缓存：键是「id|mtime」，切页签/刷新时不再重复解码
        private readonly Dictionary<string, BitmapImage> _thumbs = new();

        // 计时探针：WHALE_PROBE=1 才写 launcher.log，默认完全不产生额外日志
        private static readonly bool ProbeOn =
            string.Equals(Environment.GetEnvironmentVariable("WHALE_PROBE"), "1", StringComparison.Ordinal);

        private void Probe(string text)
        {
            if (!ProbeOn) return;
            try { _sup.Say("[probe] " + text); } catch { /* 探针不许影响界面 */ }
        }

        public StickerPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            Loaded += async (_, __) => await RefreshAsync();
        }

        public async Task RefreshAsync()
        {
            if (DateTime.UtcNow < _nextRefresh) { Probe("RefreshAsync 被 5 秒节流跳过"); return; }
            if (_refreshLock.CurrentCount == 0)
            {
                // 以前这里是静默 return —— 用户点「刷新」没反应就是这个。改成记账，跑完补一次。
                _refreshPending = true;
                Probe("RefreshAsync 上一轮还没跑完，已记为待补跑");
                return;
            }
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
            if (_refreshPending)
            {
                _refreshPending = false;
                _nextRefresh = DateTime.MinValue;   // 补跑一次不受 5 秒节流限制
                _ = LoadAsync();
            }
        }

        /* ── 取数：在线走 HTTP（一次拿全），离线退回本地子进程 ─────────────── */

        private async Task LoadCoreAsync()
        {
            var tLoad = Stopwatch.StartNew();
            var online = _sup.NodeRunning;
            ChkEnabled.IsEnabled = TxtDir.IsEnabled = online;

            var view = new ViewData();
            var tFetch = Stopwatch.StartNew();
            var status = online ? await Api.Get(_sup.Url, "/api/stickers/status") : new ApiResult();
            tFetch.Stop();

            if (online && status.Ok && status.Prop("emotions").ValueKind == JsonValueKind.Array)
            {
                view.Online = true;
                view.Enabled = status.Bool("enabled");
                view.Dir = status.Str("dir");
                view.ConfiguredDir = status.Str("configuredDir");
                view.TestChat = status.Str("testChat");
                view.Pending = status.Long("pending");
                var m = status.Prop("maintenance");
                if (m.ValueKind == JsonValueKind.Object)
                {
                    view.MaintPhase = Str(m, "phase");
                    view.MaintDone = (int)Num(m, "done");
                    view.MaintTotal = (int)Num(m, "total");
                }
                view.Emotions = ParseEmotions(status.Prop("emotions"));
            }
            else
            {
                // 内核没起来：用本地扫描兜底，至少能看图和打开文件夹
                var res = await StickerLibrary.Call(_sup.BaseDir, "inventory");
                if (!res.Ok)
                {
                    StatusText.Text = "无法读取图库：" + res.Error;
                    Probe($"LoadCore 失败 inventory={tFetch.ElapsedMilliseconds}ms err={res.Error}");
                    return;
                }
                _inventory = res;
                view.Online = false;
                view.Enabled = res.Bool("enabled");
                view.Dir = res.Str("dir");
                view.ConfiguredDir = res.Str("configuredDir");
                view.TestChat = res.Str("testChat");
                view.Emotions = ParseEmotions(res.Prop("emotions"));
            }

            _loading = true;
            ChkEnabled.IsChecked = view.Enabled;
            _loading = false;
            if (!string.IsNullOrEmpty(view.Dir)) _libraryDir = view.Dir;

            // 分类集合没变就不重排页签（重排会把用户正在点的按钮换掉）
            var keys = string.Join(",", view.Emotions.Select((e) => e.Key));
            var oldKeys = string.Join(",", _emotions.Select((e) => e.Key));
            _emotions.Clear();
            _emotions.AddRange(view.Emotions);
            if (_current.Length == 0 || !_emotions.Any((x) => x.Key == _current))
                _current = _emotions.Count > 0 ? _emotions[0].Key : "";
            if (keys != oldKeys) BuildTabs();
            else HighlightTabs();

            DirHint.Text = "目录：" + view.Dir;
            if (string.IsNullOrWhiteSpace(TxtTestChat.Text)) TxtTestChat.Text = view.TestChat;
            if (!TxtDir.IsKeyboardFocusWithin) TxtDir.Text = view.ConfiguredDir;

            // 内容签名：张数 + 每张 id/版本。没变就什么都不做（以前每次都整表重建）
            var signature = _current + "|" + string.Join(",", CurrentItems().Select((i) => i.Id + "@" + i.Version));
            var total = _emotions.Sum((e) => e.Items.Count);
            if (!_loaded || signature != _renderedSignature)
            {
                _renderedSignature = signature;
                RenderGridInBackground();   // 不 await：取数路径不被几百张缩略图拖住
            }

            QueueInfo.Text = !view.Online ? "内核未启动" : !view.Enabled ? "发送已关闭"
                : view.Pending > 0 ? $"排队中 {view.Pending} 张" : "队列空";
            if (!view.Online) StatusText.Text = "内核未运行：这里显示的是本地目录内容，启动后才能真的发送。";
            else if (view.MaintPhase == "running" || view.MaintPhase == "pending")
                StatusText.Text = $"正在整理旧图 {view.MaintDone}/{Math.Max(view.MaintDone, view.MaintTotal)}…";
            else StatusText.Text = $"就绪 · 共 {total} 张";
            RenderJobs(status.Prop("jobs"));
            _loaded = true;
            Probe($"LoadCore 完成 在线={view.Online} 取数={tFetch.ElapsedMilliseconds}ms 总计={tLoad.ElapsedMilliseconds}ms 分类={_emotions.Count} 张数={total}");
        }

        private sealed class ViewData
        {
            public bool Online;
            public bool Enabled;
            public string Dir = "";
            public string ConfiguredDir = "";
            public string TestChat = "";
            public long Pending;
            public string MaintPhase = "";
            public int MaintDone;
            public int MaintTotal;
            public List<EmotionVm> Emotions = new();
        }

        private static List<EmotionVm> ParseEmotions(JsonElement arr)
        {
            var list = new List<EmotionVm>();
            if (arr.ValueKind != JsonValueKind.Array) return list;
            foreach (var e in arr.EnumerateArray())
            {
                var vm = new EmotionVm
                {
                    Key = Str(e, "key"),
                    Label = Str(e, "label"),
                    Extra = Bool(e, "extra"),
                };
                var items = e.ValueKind == JsonValueKind.Object && e.TryGetProperty("items", out var it) ? it : default;
                if (items.ValueKind == JsonValueKind.Array)
                {
                    foreach (var i in items.EnumerateArray())
                    {
                        vm.Items.Add(new CellVm
                        {
                            Id = Str(i, "id"),
                            Name = Str(i, "name"),
                            Path = Str(i, "path"),
                            Version = (long)Num(i, "version"),
                        });
                    }
                }
                list.Add(vm);
            }
            return list;
        }

        private List<CellVm> CurrentItems()
        {
            var emotion = _emotions.FirstOrDefault((e) => e.Key == _current);
            return emotion?.Items ?? new List<CellVm>();
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

        /* ── 页签 ──────────────────────────────────────────────── */

        private void BuildTabs()
        {
            Tabs.Children.Clear();
            _currentIsExtra = _current.StartsWith("x:");
            if (BtnDelCat != null) BtnDelCat.Visibility = _currentIsExtra ? Visibility.Visible : Visibility.Collapsed;
            foreach (var emotion in _emotions)
            {
                var key = emotion.Key;
                var btn = new Button
                {
                    Content = emotion.Label,
                    Height = 28,
                    Padding = new Thickness(14, 0, 14, 0),
                    Margin = new Thickness(0, 0, 6, 0),
                    Style = (Style)FindResource(key == _current ? "Primary" : "Ghost"),
                    Tag = key
                };
                btn.Click += (s, e) => OnTabClick(key);
                Tabs.Children.Add(btn);
            }
        }

        /// <summary>只改高亮，不重建按钮（重建会把正在按的那颗按钮换掉）。</summary>
        private void HighlightTabs()
        {
            if (Tabs.Children.Count != _emotions.Count) { BuildTabs(); return; }
            for (var i = 0; i < Tabs.Children.Count; i++)
            {
                if (Tabs.Children[i] is Button btn && btn.Tag is string key)
                    btn.Style = (Style)FindResource(key == _current ? "Primary" : "Ghost");
            }
            _currentIsExtra = _current.StartsWith("x:");
            if (BtnDelCat != null) BtnDelCat.Visibility = _currentIsExtra ? Visibility.Visible : Visibility.Collapsed;
        }

        /// <summary>
        /// 点页签：先立刻高亮 + 用手上已有的数据上骨架（不等待任何 IO），
        /// 再去后台取一次最新数据。以前点下去要等一整个 inventory（630ms）才有反应。
        /// </summary>
        private void OnTabClick(string key)
        {
            var t0 = Stopwatch.StartNew();
            _current = key;
            HighlightTabs();
            _renderedSignature = _current + "|" + string.Join(",", CurrentItems().Select((i) => i.Id + "@" + i.Version));
            RenderGridInBackground();   // 骨架先上屏，解码在后台补；点击本身不等图
            Probe($"页签 {key} 点击返回 {t0.ElapsedMilliseconds}ms 张数={CurrentItems().Count} 缓存={_thumbs.Count}");
            _nextRefresh = DateTime.MinValue;          // 让后台刷新立刻补上最新数据
            _ = RefreshAsync();
        }

        /* ── 网格 ──────────────────────────────────────────────── */

        /// <summary>后台渲染；异常只记一行，不许把界面搞崩（async void 抛异常会直接闪退）。</summary>
        private void RenderGridInBackground()
        {
            _ = RenderGridAsync().ContinueWith(
                (t) => Probe("RenderGrid 异常：" + (t.Exception?.GetBaseException().Message ?? "")),
                TaskContinuationOptions.OnlyOnFaulted);
        }

        private async Task RenderGridAsync()
        {
            var tGrid = Stopwatch.StartNew();
            _preview.Cancel();
            _preview.Dispose();
            _preview = new CancellationTokenSource();
            var token = _preview.Token;

            var selected = _current;
            var items = CurrentItems();
            GridHost.Children.Clear();
            EmptyHint.Text = "这个分类还是空的。点「打开分类文件夹」，把 GIF / PNG / JPG / WebP 拖进去。";
            EmptyHint.Visibility = items.Count > 0 ? Visibility.Collapsed : Visibility.Visible;
            if (items.Count == 0) return;

            // 骨架和解码流水线：每上屏 24 个骨架就把这几个的解码排进去，
            // 首图不必等 200 个骨架全部建完（以前首图 = 整个骨架循环 + 一次解码）。
            var sem = new SemaphoreSlim(DecodeConcurrency);
            var cells = new List<(Image Img, CellVm Item)>(items.Count);
            var pending = new List<Task>(items.Count);
            var done = 0;
            long firstAt = -1;
            var hit = 0;

            async Task LoadCellAsync((Image Img, CellVm Item) c)
            {
                var acquired = false;
                try
                {
                    await sem.WaitAsync(token).ConfigureAwait(true);
                    acquired = true;
                    if (token.IsCancellationRequested) return;
                    var cached = ThumbFor(c.Item);
                    BitmapImage bmp;
                    if (cached != null) { bmp = cached; Interlocked.Increment(ref hit); }
                    else
                    {
                        bmp = await Task.Run(() => ReadThumbnail(c.Item.Path, token), token);
                        if (bmp != null) RememberThumb(c.Item, bmp);
                    }
                    if (token.IsCancellationRequested || bmp == null) return;
                    c.Img.Source = bmp;
                    c.Img.Visibility = Visibility.Visible;
                    var n = Interlocked.Increment(ref done);
                    if (firstAt < 0) firstAt = tGrid.ElapsedMilliseconds;
                    if (n % 24 == 0 && !token.IsCancellationRequested)
                        StatusText.Text = $"正在加载缩略图 {n}/{cells.Count}";
                }
                catch (OperationCanceledException) { /* 切页签取消：正常路径，不许让它把进程干掉 */ }
                catch (Exception ex) { Probe("缩略图解码失败：" + ex.GetType().Name); }
                finally { if (acquired) sem.Release(); }
            }

            StatusText.Text = $"正在加载缩略图 0/{items.Count}";
            for (var i = 0; i < items.Count; i++)
            {
                var (cell, img) = BuildSkeleton(items[i]);
                GridHost.Children.Add(cell);
                cells.Add((img, items[i]));
                pending.Add(LoadCellAsync(cells[cells.Count - 1]));
                if ((i + 1) % 24 == 0)
                {
                    if (i + 1 == 24) Probe($"RenderGrid 骨架 分类={selected} 首屏={tGrid.ElapsedMilliseconds}ms");
                    await Dispatcher.Yield(DispatcherPriority.Background);
                }
            }
            await Task.WhenAll(pending);
            if (token.IsCancellationRequested)
            {
                Probe($"RenderGrid 分类={selected} 被取消 已上屏={done}/{cells.Count} 用时={tGrid.ElapsedMilliseconds}ms");
                return;
            }
            StatusText.Text = $"刚换到「{_emotions.FirstOrDefault((e) => e.Key == selected)?.Label}」· {cells.Count} 张";
            Probe($"RenderGrid 填满 分类={selected} 张数={cells.Count} 首图={firstAt}ms 缓存命中={hit} 总计={tGrid.ElapsedMilliseconds}ms");
        }

        private BitmapImage ThumbFor(CellVm item)
        {
            var key = item.Id + "|" + item.Version;
            return _thumbs.TryGetValue(key, out var bmp) ? bmp : null;
        }

        private void RememberThumb(CellVm item, BitmapImage bmp)
        {
            // 简单上限：超过就整块丢掉，宁可重解码也不要慢慢吃掉几百 MB
            if (_thumbs.Count >= ThumbCacheMax) _thumbs.Clear();
            _thumbs[item.Id + "|" + item.Version] = bmp;
        }

        private static BitmapImage ReadThumbnail(string path, CancellationToken token)
        {
            if (token.IsCancellationRequested || string.IsNullOrEmpty(path)) return null;
            try
            {
                using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                var image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.DecodePixelWidth = ThumbWidth;
                image.StreamSource = stream;
                image.EndInit();
                image.Freeze();
                return image;
            }
            catch (Exception) { return null; }
        }

        /// <summary>骨架格子：尺寸和正式格子一样，图片槽先空着（图加载完只赋 Source）。</summary>
        private (Border Cell, Image Img) BuildSkeleton(CellVm item)
        {
            var border = new Border
            {
                Width = 120, Height = 120, Margin = new Thickness(0, 0, 10, 10),
                CornerRadius = new CornerRadius(8), ClipToBounds = true, ToolTip = item.Name
            };
            border.SetResourceReference(Border.BackgroundProperty, "Surface3");
            var grid = new Grid();
            var image = new Image { Stretch = Stretch.UniformToFill, Visibility = Visibility.Collapsed };
            grid.Children.Add(image);
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
                Tag = item.Id
            };
            del.Click += async (s, e) =>
            {
                if (!CanManageOnline()) return;
                var n = (string)((Button)s).Tag;
                var confirm = MessageBox.Show($"删掉这张？\n\n{n}", "表情包", MessageBoxButton.OKCancel, MessageBoxImage.Question);
                if (confirm != MessageBoxResult.OK) return;
                var r = await Api.Post(_sup.Url, "/api/stickers/delete",
                    $"{{\"emotion\":\"{Api.Esc(_current)}\",\"name\":\"{Api.Esc(n)}\"}}");
                StatusText.Text = r.Ok ? "已删除 " + n : "删除失败：" + (r.Error.Length > 0 ? r.Error : r.Raw);
                if (r.Ok)
                {
                    _renderedSignature = "";   // 强制下次重建
                    await LoadAsync();
                }
            };
            grid.Children.Add(del);
            // 右键：在资源管理器里定位这张图（内核在线走 API，离线本地拼路径）
            var menu = new ContextMenu();
            var reveal = new MenuItem { Header = "在文件夹中显示" };
            reveal.Click += async (s, e) => await ShowStickerFolder(_current, item.Id);
            menu.Items.Add(reveal);
            border.ContextMenu = menu;
            border.Child = grid;
            return (border, image);
        }

        private void RenderJobs(JsonElement arr)
        {
            JobsHost.Children.Clear();
            if (arr.ValueKind != JsonValueKind.Array) return;
            var shown = 0;
            foreach (var j in arr.EnumerateArray())
            {
                var status = Str(j, "status");
                var chat = Str(j, "chat");
                var file = Str(j, "filename");
                var err = FriendlyError(Str(j, "error"));
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
                _loaded = false;
                _nextRefresh = DateTime.MinValue;
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
                _loaded = false;
                _nextRefresh = DateTime.MinValue;
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
            _nextRefresh = DateTime.MinValue;
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
            // 右上角：整个表情包库根目录（data/stickers）
            await ShowStickerFolder("");
        }

        private async void OnOpenCategoryFolder(object sender, RoutedEventArgs e)
        {
            // 页签行：当前分类自己的文件夹
            if (string.IsNullOrEmpty(_current))
            {
                StatusText.Text = "先选一个分类。";
                return;
            }
            await ShowStickerFolder(_current);
        }

        /// <summary>
        /// 打开目标目录（三处共用）：页签行的「打开分类文件夹」、单图右键「在文件夹中显示」、
        /// 以及内核不在时的降级动作。内核在线走 API（带 emotion/name），
        /// 不在就本地拼路径自己开 —— 文件夹本身就是存储，不依赖内核。
        /// </summary>
        private async Task ShowStickerFolder(string emotion, string name = null)
        {
            var body = "{\"emotion\":\"" + Api.Esc(emotion ?? "") + "\""
                + (string.IsNullOrEmpty(name) ? "" : ",\"name\":\"" + Api.Esc(name) + "\"") + "}";
            var res = _sup.NodeRunning
                ? await Api.Post(_sup.Url, "/api/stickers/open-folder", body)
                : new ApiResult { Ok = false, Error = "内核未运行" };
            if (res.Ok)
            {
                StatusText.Text = res.Str("mode") == "select" ? "已在资源管理器里定位这张图" : "已打开：" + res.Str("dir");
                return;
            }
            // 降级：本地拼路径（中文标签，不是 key）
            var target = LocalPath(emotion, name);
            if (target == null)
            {
                StatusText.Text = "打不开：" + Api.FriendlyError(res.Error.Length > 0 ? res.Error : "内核未运行");
                return;
            }
            try
            {
                var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"))
                {
                    UseShellExecute = false
                };
                start.ArgumentList.Add(name == null ? target : "/select," + target);
                using var explorer = Process.Start(start);
                StatusText.Text = name == null
                    ? "把图片拖进已打开的文件夹。图库会自动刷新。"
                    : "已在资源管理器里定位这张图";
            }
            catch (Exception ex) { StatusText.Text = "无法打开资源管理器：" + ex.Message; }
        }

        private string LocalPath(string emotion, string name)
        {
            if (string.IsNullOrEmpty(_libraryDir)) return null;
            if (string.IsNullOrEmpty(emotion)) return _libraryDir;
            if (!string.IsNullOrEmpty(name))
            {
                var full = Path.Combine(_libraryDir, name.Replace('/', Path.DirectorySeparatorChar));
                return File.Exists(full) ? full : null;
            }
            var label = _emotions.FirstOrDefault((e) => e.Key == emotion)?.Label;
            if (string.IsNullOrEmpty(label)) return null;
            var dir = Path.Combine(_libraryDir, label);
            return Directory.Exists(dir) ? dir : null;
        }

        private async void OnReload(object sender, RoutedEventArgs e)
        {
            _loaded = false;
            _renderedSignature = "";
            _nextRefresh = DateTime.MinValue;
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

        private static string Str(JsonElement e, string n)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

        private static bool Bool(JsonElement e, string n)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.True;

        private static double Num(JsonElement e, string n)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(n, out var v)) return 0;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d)) return d;
            if (v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), out var s)) return s;
            return 0;
        }

        private static string S(JsonElement e, string n) => Str(e, n);
    }
}
