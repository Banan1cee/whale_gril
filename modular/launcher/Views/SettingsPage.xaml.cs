using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views
{
    public sealed class ProviderItem
    {
        public string Key { get; set; }
        public string Label { get; set; }
        public override string ToString() => Label ?? Key ?? "";
    }

    public partial class SettingsPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private bool _loading;
        private string _webhook = "";
        private DateTime _lastLoad = DateTime.MinValue;

        public SettingsPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            Loaded += async (_, __) => { MainScroll.ScrollToTop(); await RefreshAsync(); };
        }

        public async Task RefreshAsync()
        {
            if (!_sup.NodeRunning)
            {
                KernelHint.Text = "内核没起，设置读不到也存不了。点顶栏 ⏻ 启动。";
                return;
            }
            KernelHint.Text = "配置改动立即写回 config.json / settings.json";
            if ((DateTime.Now - _lastLoad).TotalSeconds < 8) return;
            _lastLoad = DateTime.Now;
            await LoadAsync();
        }

        private async Task LoadAsync()
        {
            var set = await Api.Get(_sup.Url, "/api/settings");
            if (set.Ok) _lastSet = set;
            if (set.Ok)
            {
                _loading = true;
                try
                {
                    var items = new List<ProviderItem>();
                    var provs = set.Prop("providers");
                    if (provs.ValueKind == JsonValueKind.Object)
                    {
                        foreach (var p in provs.EnumerateObject())
                        {
                            var label = p.Value.TryGetProperty("label", out var lb) && lb.ValueKind == JsonValueKind.String
                                ? lb.GetString() : p.Name;
                            items.Add(new ProviderItem { Key = p.Name, Label = $"{label}（{p.Name}）" });
                        }
                    }
                    CmbProvider.ItemsSource = items;
                    var cur = set.Str("provider");
                    CmbProvider.SelectedItem = items.FirstOrDefault(x => x.Key == cur);

                    TxtBaseUrl.Text = set.Str("baseUrl");
                    TxtModel.Text = set.Str("model");
                    TxtKey.Password = "";
                    ChkMock.IsChecked = set.Bool("mock");

                    var hasKey = set.Bool("hasKey");
                    ModelNow.Text = $"{set.Str("providerLabel")} · {set.Str("model")} · {set.Str("baseUrl")}" +
                                    (hasKey ? $" · Key {set.Str("keyMasked")}" : " · 还没填 Key");
                    TxtKey.ToolTip = hasKey ? "已存 " + set.Str("keyMasked") + "，留空表示不改" : "没填过 Key";

                    var v = set.Prop("vision");
                    if (v.ValueKind == JsonValueKind.Object)
                    {
                        var configured = v.TryGetProperty("configured", out var c) && c.ValueKind == JsonValueKind.True;
                        var masked = v.TryGetProperty("keyMasked", out var km) && km.ValueKind == JsonValueKind.String ? km.GetString() : "";
                        var model = v.TryGetProperty("model", out var md) && md.ValueKind == JsonValueKind.String ? md.GetString() : "";
                        VisionNow.Text = configured ? $"已配置 · {model} · {masked}" : "没配置。填一把智谱 GLM-4V 的 Key 才能看图。";
                    }
                }
                finally { _loading = false; }
            }

            var cfg = await Api.Get(_sup.Url, "/api/config");
            if (cfg.Ok && cfg.Prop("config").ValueKind == JsonValueKind.Object)
            {
                var c = cfg.Prop("config");
                _loading = true;
                try
                {
                    if (c.TryGetProperty("websearch", out var ws) && ws.ValueKind == JsonValueKind.Object)
                    {
                        ChkSearch.IsChecked = BoolOf(ws, "enabled");
                        TxtCity.Text = StrOf(ws, "city");
                    }
                    if (c.TryGetProperty("links", out var lk) && lk.ValueKind == JsonValueKind.Object)
                        ChkLinks.IsChecked = BoolOf(lk, "enabled");
                    if (c.TryGetProperty("log", out var lg) && lg.ValueKind == JsonValueKind.Object)
                    {
                        var lvl = StrOf(lg, "level");
                        CmbLog.SelectedIndex = lvl == "debug" ? 1 : 0;
                    }
                    if (c.TryGetProperty("share", out var sh) && sh.ValueKind == JsonValueKind.Object)
                    {
                        ChkShare.IsChecked = BoolOf(sh, "enabled");
                        var mins = sh.TryGetProperty("everyMinutes", out var em) && em.ValueKind == JsonValueKind.Number ? em.GetInt32() : 120;
                        TxtShareMin.Text = mins.ToString();
                    }

                    var port = _sup.Port;
                    if (c.TryGetProperty("gateway", out var gw) && gw.ValueKind == JsonValueKind.Object)
                    {
                        var lines = new List<string>();
                        foreach (var p in gw.EnumerateObject())
                        {
                            var path = $"/webhook/{p.Name}";
                            var enabled = p.Value.ValueKind == JsonValueKind.Object && BoolOf(p.Value, "enabled");
                            lines.Add($"{path}   {(enabled ? "已启用" : "未启用")}");
                            if (p.Name == "wechat") _webhook = $"http://127.0.0.1:{port}{path}";
                        }
                        GatewayInfo.Text = $"本机地址：http://127.0.0.1:{port}\n" + string.Join("\n", lines) +
                                           "\n\n给别的客户端接入时才需要；桥接自己用的是这一套，不用改。";
                    }

                    var version = "v4.0.0-alpha";
                    var pkg = Path.Combine(AppContext.BaseDirectory, "package.json");
                    if (File.Exists(pkg))
                    {
                        var m = System.Text.RegularExpressions.Regex.Match(File.ReadAllText(pkg), "\"version\"\\s*:\\s*\"([^\"]+)\"");
                        if (m.Success) version = "v" + m.Groups[1].Value;
                    }
                    AboutInfo.Text = $"鲸鲸 {version} · 启动器 4.0\n配置文件：{set.Str("configFile")}\n数据目录：{set.Str("dataDir")}";
                }
                finally { _loading = false; }
            }
        }

        private static bool BoolOf(JsonElement e, string n)
            => e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.True;

        private static string StrOf(JsonElement e, string n)
            => e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

        // ── 动作 ────────────────────────────────────────────────
        private void OnProviderChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_loading) return;
            if (CmbProvider.SelectedItem is ProviderItem p)
            {
                // 只是先填进输入框，点保存才写盘
                var set = _lastSet;
                if (set != null && set.Prop("providers").ValueKind == JsonValueKind.Object &&
                    set.Prop("providers").TryGetProperty(p.Key, out var pv))
                {
                    TxtBaseUrl.Text = StrOf(pv, "baseUrl");
                    TxtModel.Text = StrOf(pv, "model");
                    ModelResult.Text = "已切到 " + p.Label + " 的预设值，点「保存」才写盘。";
                }
            }
        }

        private ApiResult _lastSet;

        private async void OnSaveModel(object sender, RoutedEventArgs e)
        {
            var provider = (CmbProvider.SelectedItem as ProviderItem)?.Key ?? "";
            var json = "{" +
                       $"\"provider\":\"{Api.Esc(provider)}\"," +
                       $"\"baseUrl\":\"{Api.Esc(TxtBaseUrl.Text.Trim())}\"," +
                       $"\"model\":\"{Api.Esc(TxtModel.Text.Trim())}\"," +
                       $"\"mock\":{(ChkMock.IsChecked == true ? "true" : "false")}";
            if (TxtKey.Password.Length > 0) json += $",\"apiKey\":\"{Api.Esc(TxtKey.Password.Trim())}\"";
            json += "}";
            var res = await Api.Post(_sup.Url, "/api/settings", json);
            ModelResult.Text = res.Ok ? "已保存。" + Summarize(res) : "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            if (res.Ok) { TxtKey.Password = ""; _lastLoad = DateTime.MinValue; await RefreshAsync(); }
        }

        private async void OnTestModel(object sender, RoutedEventArgs e)
        {
            ModelResult.Text = "正在测…（可能要几秒）";
            var res = await Api.Post(_sup.Url, "/api/settings/test", "{}");
            if (!res.Ok)
            {
                ModelResult.Text = "测试没通过：" + (res.Error.Length > 0 ? res.Error : res.Raw);
                return;
            }
            var probe = res.Prop("probe");
            var ms = probe.ValueKind == JsonValueKind.Object && probe.TryGetProperty("ms", out var m) && m.ValueKind == JsonValueKind.Number ? m.GetInt64() : 0;
            var model = probe.ValueKind == JsonValueKind.Object && probe.TryGetProperty("model", out var md) && md.ValueKind == JsonValueKind.String ? md.GetString() : "";
            ModelResult.Text = $"连通正常 · {model} · {ms} ms";
        }

        private static string Summarize(ApiResult res)
        {
            var s = res.Prop("settings");
            if (s.ValueKind != JsonValueKind.Object) return "";
            return $"{StrOf(s, "providerLabel")} · {StrOf(s, "model")}" +
                   (BoolOf(s, "mock") ? " · 演示模式" : "");
        }

        private async void OnSaveVision(object sender, RoutedEventArgs e)
        {
            if (TxtVisionKey.Password.Trim().Length == 0)
            {
                VisionResult.Text = "留空就不改。要存新 Key 请先填进去。";
                return;
            }
            var res = await Api.Post(_sup.Url, "/api/settings",
                $"{{\"visionApiKey\":\"{Api.Esc(TxtVisionKey.Password.Trim())}\"}}");
            VisionResult.Text = res.Ok ? "看图 Key 已保存。" : "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            if (res.Ok) { TxtVisionKey.Password = ""; _lastLoad = DateTime.MinValue; await RefreshAsync(); }
        }

        private async void OnTestVision(object sender, RoutedEventArgs e)
        {
            VisionResult.Text = "正在测…（拿一张内置小图问颜色）";
            var res = await Api.Post(_sup.Url, "/api/vision/test", "{}");
            VisionResult.Text = res.Ok ? "看图通了，它说：" + res.Str("sample") : "没通：" + (res.Error.Length > 0 ? res.Error : res.Raw);
        }

        private async void OnSaveMisc(object sender, RoutedEventArgs e)
        {
            var minutes = int.TryParse(TxtShareMin.Text.Trim(), out var m) ? Math.Max(5, m) : 120;
            var json = "{\"patch\":{" +
                       $"\"websearch\":{{\"enabled\":{(ChkSearch.IsChecked == true ? "true" : "false")},\"city\":\"{Api.Esc(TxtCity.Text.Trim())}\"}}," +
                       $"\"links\":{{\"enabled\":{(ChkLinks.IsChecked == true ? "true" : "false")}}}," +
                       $"\"log\":{{\"level\":\"{(CmbLog.SelectedIndex == 1 ? "debug" : "info")}\"}}," +
                       $"\"share\":{{\"enabled\":{(ChkShare.IsChecked == true ? "true" : "false")},\"everyMinutes\":{minutes}}}" +
                       "}}";
            var res = await Api.Post(_sup.Url, "/api/config", json);
            MiscResult.Text = res.Ok ? "已保存。日志级别改动立即生效。" : "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
        }

        private void OnCopyWebhook(object sender, RoutedEventArgs e)
        {
            try
            {
                Clipboard.SetText(string.IsNullOrEmpty(_webhook) ? $"http://127.0.0.1:{_sup.Port}/webhook/wechat" : _webhook);
                GatewayInfo.Text += "\n（已复制到剪贴板）";
            }
            catch (Exception ex)
            {
                GatewayInfo.Text += "\n复制失败：" + ex.Message;
            }
        }

        private void OnOpenGatewayDoc(object sender, RoutedEventArgs e)
            => Open(Path.Combine(AppContext.BaseDirectory, "docs", "GATEWAY.md"));

        private void OnOpenConsole(object sender, RoutedEventArgs e) => Open(_sup.Url);

        private void OnOpenData(object sender, RoutedEventArgs e) => Open(Path.Combine(AppContext.BaseDirectory, "data"));

        private void OnOpenConfig(object sender, RoutedEventArgs e) => Open(Path.Combine(AppContext.BaseDirectory, "config.json"));

        private void Open(string target)
        {
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
            catch (Exception ex) { ModelResult.Text = "打开失败：" + ex.Message; }
        }
    }
}
