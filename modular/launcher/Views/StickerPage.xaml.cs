using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
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

        public StickerPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            Loaded += async (_, __) => await RefreshAsync();
        }

        public async Task RefreshAsync()
        {
            if (!_sup.NodeRunning || _loaded) return;
            await LoadAsync();
        }

        private async Task LoadAsync()
        {
            var res = await Api.Get(_sup.Url, "/api/stickers/status");
            if (!res.Ok)
            {
                // 功能关闭时接口会 404，这是正常的
                ChkEnabled.IsChecked = await ReadFlagAsync();
                EmptyHint.Visibility = Visibility.Visible;
                EmptyHint.Text = "表情包功能还没开。\n打开上面的开关，再把图片拖进来（或者点「上传图片…」）。";
                GridHost.Children.Clear();
                Tabs.Children.Clear();
                StatusText.Text = "接口返回：" + (res.Error.Length > 0 ? res.Error : res.Raw);
                _loaded = true;
                return;
            }

            _loading = true;
            ChkEnabled.IsChecked = true;
            _loading = false;

            _emotions.Clear();
            var arr = res.Prop("emotions");
            if (arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var e in arr.EnumerateArray())
                    _emotions.Add((S(e, "key"), S(e, "label")));
            }
            if (_current.Length == 0 || !_emotions.Any(x => x.Key == _current))
                _current = _emotions.Count > 0 ? _emotions[0].Key : "";

            BuildTabs();
            RenderGrid(res);
            DirHint.Text = "目录：" + res.Str("dir");

            var pending = res.Long("pending");
            QueueInfo.Text = pending > 0 ? $"排队中 {pending} 张" : "队列空";
            StatusText.Text = $"共 {_emotions.Sum(x => CountOf(res, x.Key))} 张图。发送测试会排进队列，由桥接按「微信在前台」的时机真的发出去。";
            _loaded = true;
        }

        private long CountOf(ApiResult res, string key)
        {
            if (res.Prop("emotions").ValueKind != JsonValueKind.Array) return 0;
            foreach (var e in res.Prop("emotions").EnumerateArray())
                if (S(e, "key") == key) return e.TryGetProperty("count", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetInt64() : 0;
            return 0;
        }

        private void BuildTabs()
        {
            Tabs.Children.Clear();
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
                    _ = LoadAsync();
                };
                Tabs.Children.Add(btn);
            }
        }

        private void RenderGrid(ApiResult res)
        {
            GridHost.Children.Clear();
            var emotion = res.Prop("emotions");
            if (emotion.ValueKind != JsonValueKind.Array) return;

            var any = false;
            foreach (var e in emotion.EnumerateArray())
            {
                if (S(e, "key") != _current) continue;
                if (!e.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) continue;

                foreach (var it in items.EnumerateArray())
                {
                    any = true;
                    var name = S(it, "name");
                    GridHost.Children.Add(BuildCell(name));
                }
            }

            EmptyHint.Visibility = any ? Visibility.Collapsed : Visibility.Visible;
            if (!any)
                EmptyHint.Text = "这个分类还是空的。\n点「上传图片…」挑几张（GIF / PNG / JPG / WebP，单张 4MB 以内）。";
        }

        private FrameworkElement BuildCell(string name)
        {
            var border = new Border
            {
                Width = 120,
                Height = 120,
                Margin = new Thickness(0, 0, 10, 10),
                CornerRadius = new CornerRadius(8),
                Background = new SolidColorBrush(Color.FromRgb(0x2A, 0x2E, 0x34)),
                ClipToBounds = true,
                ToolTip = name
            };

            var grid = new Grid();
            try
            {
                var url = $"{_sup.Url}/api/stickers/image?emotion={Uri.EscapeDataString(_current)}&name={Uri.EscapeDataString(name)}";
                var bmp = new BitmapImage();
                bmp.BeginInit();
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
                bmp.UriSource = new Uri(url + "&t=" + DateTime.Now.Ticks);
                bmp.EndInit();
                var img = new Image { Source = bmp, Stretch = Stretch.UniformToFill };
                RenderOptions.SetBitmapScalingMode(img, BitmapScalingMode.HighQuality);
                grid.Children.Add(img);
            }
            catch
            {
                grid.Children.Add(new TextBlock
                {
                    Text = "读不到图",
                    Foreground = (Brush)FindResource("Muted"),
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center
                });
            }

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
                var n = (string)((Button)s).Tag;
                var confirm = MessageBox.Show($"删掉这张？\n\n{n}", "表情包", MessageBoxButton.OKCancel, MessageBoxImage.Question);
                if (confirm != MessageBoxResult.OK) return;
                var r = await Api.Post(_sup.Url, "/api/stickers/delete",
                    $"{{\"emotion\":\"{Api.Esc(_current)}\",\"name\":\"{Api.Esc(n)}\"}}");
                StatusText.Text = r.Ok ? "已删除 " + n : "删除失败：" + (r.Error.Length > 0 ? r.Error : r.Raw);
                if (r.Ok) await LoadAsync();
            };
            grid.Children.Add(del);

            border.Child = grid;
            return border;
        }

        // ── 动作 ────────────────────────────────────────────────
        private async void OnToggleEnabled(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            var on = ChkEnabled.IsChecked == true;
            var res = await Api.Post(_sup.Url, "/api/features", $"{{\"key\":\"stickers\",\"value\":{(on ? "true" : "false")}}}");
            StatusText.Text = res.Ok ? $"表情包已{(on ? "开启" : "关闭")}" : "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            _loaded = false;
            await LoadAsync();
        }

        private async Task<bool> ReadFlagAsync()
        {
            var res = await Api.Get(_sup.Url, "/api/features");
            if (res.Ok && res.Prop("features").ValueKind == JsonValueKind.Array)
                foreach (var f in res.Prop("features").EnumerateArray())
                    if (S(f, "key") == "stickers") return f.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.True;
            return false;
        }

        private void OnDragOver(object sender, DragEventArgs e)
        {
            e.Effects = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
            e.Handled = true;
        }

        private async void OnDrop(object sender, DragEventArgs e)
        {
            if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;
            var files = (string[])e.Data.GetData(DataFormats.FileDrop);
            if (files == null || files.Length == 0) return;
            var ok = files.Where(f =>
            {
                var ext = Path.GetExtension(f).ToLowerInvariant();
                return ext == ".gif" || ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".webp";
            }).ToArray();
            if (ok.Length == 0)
            {
                StatusText.Text = "拖进来的不是图片。支持 GIF / PNG / JPG / WebP。";
                return;
            }
            if (ok.Length > 5) ok = ok.Take(5).ToArray();
            await UploadFilesAsync(ok);
        }

        private async void OnUpload(object sender, RoutedEventArgs e)
        {
            var dlg = new Microsoft.Win32.OpenFileDialog
            {
                Multiselect = true,
                Filter = "图片|*.gif;*.png;*.jpg;*.jpeg;*.webp",
                Title = "挑 1~5 张表情包"
            };
            if (dlg.ShowDialog() != true) return;
            if (dlg.FileNames.Length > 5)
            {
                StatusText.Text = "一次最多 5 张，请分两批。";
                return;
            }
            await UploadFilesAsync(dlg.FileNames);
        }

        private async Task UploadFilesAsync(string[] files)
        {
            var sb = new StringBuilder();
            sb.Append("{\"emotion\":\"").Append(Api.Esc(_current)).Append("\",\"files\":[");
            var first = true;
            foreach (var f in files)
            {
                var info = new FileInfo(f);
                if (info.Length > 4 * 1024 * 1024)
                {
                    StatusText.Text = $"{info.Name} 超过 4MB，跳过。";
                    continue;
                }
                var data = Convert.ToBase64String(File.ReadAllBytes(f));
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"name\":\"").Append(Api.Esc(info.Name)).Append("\",\"data\":\"").Append(data).Append("\"}");
            }
            sb.Append("]}");

            if (first)
            {
                StatusText.Text = "没有可上传的图片。";
                return;
            }

            StatusText.Text = $"正在上传 {files.Length} 张…";
            var res = await Api.Post(_sup.Url, "/api/stickers/upload", sb.ToString());
            StatusText.Text = res.Ok ? $"已上传 {files.Length} 张。" : "上传失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            await LoadAsync();
        }

        private async void OnTestSend(object sender, RoutedEventArgs e)
        {
            if (string.IsNullOrEmpty(_current)) return;
            var res = await Api.Post(_sup.Url, "/api/stickers/test", $"{{\"emotion\":\"{Api.Esc(_current)}\"}}");
            QueueInfo.Text = res.Ok ? "已排队 1 张" : "排队失败";
            StatusText.Text = res.Ok
                ? "已排队。真正发出去的时机由桥接掌握：微信窗口在前台、账号校验通过才会发。"
                : "排队失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
        }

        private async void OnOpenFolder(object sender, RoutedEventArgs e)
        {
            var res = await Api.Post(_sup.Url, "/api/stickers/open-folder", "{}");
            if (!res.Ok) StatusText.Text = "打开失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
        }

        private async void OnReload(object sender, RoutedEventArgs e)
        {
            _loaded = false;
            await LoadAsync();
        }

        private static string S(JsonElement e, string n)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";
    }
}
