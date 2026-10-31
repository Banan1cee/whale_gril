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
    /// <summary>
    /// 「白名单 / 静音黑名单」选择器：chips 展示 + 弹窗多选 + 选完立即写回 config。
    ///
    /// 原来这段逻辑写在 SettingsPage 里（BuildContactListSelector），写完却没有任何调用点，
    /// 属于死代码；「主动与提醒」页只能用两个裸多行文本框让用户手抄 wxid。
    /// 现在提成独立控件，替换掉那两个文本框。
    ///
    /// 为什么立即保存而不是跟页面的「保存」按钮一起提交：
    /// 选择器走的是 ContactPicker 弹窗，用户点「确定」时已经表达了明确的保存意图，
    /// 再让他回页面点一次保存，忘了就白选。所以这里独立 PATCH，和 care 其余字段互不干扰。
    /// </summary>
    public sealed class ContactListEditor : UserControl
    {
        private readonly RuntimeSupervisor _sup;
        private readonly string _configPath;
        private readonly string _emptyHint;
        private readonly bool _allowAllMute;

        private readonly WrapPanel _chips;
        private readonly TextBlock _hint;
        private readonly TextBlock _error;
        private readonly Button _pick;

        private readonly Dictionary<string, ContactInfo> _cache = new Dictionary<string, ContactInfo>();
        private List<string> _items = new List<string>();
        private DateTime _lastResolve = DateTime.MinValue;
        private bool _busy;

        /// <summary>把一行结果文字抛给宿主页面（宿主自己决定显示在哪）。</summary>
        public event Action<string> Status;

        public ContactListEditor(RuntimeSupervisor sup, string configPath,
            string emptyHint, string buttonText, bool allowAllMute)
        {
            _sup = sup;
            _configPath = configPath;
            _emptyHint = emptyHint;
            _allowAllMute = allowAllMute;

            var grid = new Grid { Margin = new Thickness(0, 0, 0, 2) };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var left = new StackPanel { Margin = new Thickness(0, 0, 10, 0) };
            _chips = new WrapPanel { VerticalAlignment = VerticalAlignment.Center };
            _hint = new TextBlock
            {
                Style = (Style)FindResource("Small"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 4, 0, 0)
            };
            _error = new TextBlock
            {
                Style = (Style)FindResource("Small"),
                Foreground = (Brush)FindResource("Warn"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 3, 0, 0),
                Visibility = Visibility.Collapsed
            };
            left.Children.Add(_chips);
            left.Children.Add(_hint);
            left.Children.Add(_error);

            _pick = new Button
            {
                Content = buttonText,
                Style = (Style)FindResource("Ghost"),
                VerticalAlignment = VerticalAlignment.Top
            };
            _pick.Click += async (_, __) => await PickAsync();

            grid.Children.Add(left);
            Grid.SetColumn(_pick, 1);
            grid.Children.Add(_pick);
            Content = grid;

            Render();
        }

        /// <summary>从 config 回填。</summary>
        public void SetValue(JsonElement v)
        {
            _items = ReadArray(v);
            Render();
            _ = ResolveNamesAsync();
        }

        public IReadOnlyList<string> Items => _items;

        private async Task PickAsync()
        {
            if (_busy) return;
            if (!_sup.NodeRunning)
            {
                SetError("内核没起，选不了联系人。点顶栏 ⏻ 启动后再试。");
                return;
            }

            var dlg = new ContactPicker(_sup, _items, _cache, _allowAllMute)
            {
                Owner = Window.GetWindow(this)
            };
            if (dlg.ShowDialog() != true) return;

            foreach (var kv in dlg.KnownContacts) _cache[kv.Key] = kv.Value;
            var ids = new List<string>(dlg.SelectedIds);

            _busy = true;
            _pick.IsEnabled = false;
            try
            {
                var body = "{\"patch\":{\"" + Api.Esc(_configPath) + "\":" + ArrayLiteral(ids) + "}}";
                var res = await Api.Post(_sup.Url, "/api/config", body);
                if (!res.Ok)
                {
                    SetError("保存失败：" + Detail(res));
                    Status?.Invoke("白名单 / 黑名单保存失败，界面先保留旧值。");
                    return;
                }
                _items = ids;
                SetError("");
                Render();
                Status?.Invoke("已保存 " + DateTime.Now.ToString("HH:mm:ss"));
            }
            finally
            {
                _busy = false;
                _pick.IsEnabled = true;
            }
        }

        /// <summary>把已存的 wxid 换成显示名；接口没上线就保留原始 wxid 并提示。</summary>
        private async Task ResolveNamesAsync()
        {
            if (!_sup.NodeRunning) return;
            if (!NeedNames()) return;
            if ((DateTime.Now - _lastResolve).TotalSeconds < 60) return;
            _lastResolve = DateTime.Now;

            var res = await Api.Get(_sup.Url, "/api/wechat/contacts?type=all");
            if (!res.Ok)
            {
                SetError("联系人接口没就绪（GET /api/wechat/contacts 失败），先显示原始 wxid。");
                return;
            }
            var items = res.Prop("items");
            if (items.ValueKind == JsonValueKind.Array)
            {
                foreach (var it in items.EnumerateArray())
                {
                    if (it.ValueKind != JsonValueKind.Object) continue;
                    var wxid = GetStr(it, "wxid");
                    if (wxid.Length == 0) continue;
                    _cache[wxid] = new ContactInfo
                    {
                        Wxid = wxid,
                        Name = GetStr(it, "name"),
                        Remark = GetStr(it, "remark"),
                        IsGroup = it.TryGetProperty("isGroup", out var g) && g.ValueKind == JsonValueKind.True
                    };
                }
            }
            SetError("");
            Render();
        }

        private bool NeedNames() => _items.Any(id =>
            !string.IsNullOrEmpty(id) && id != "*" && id != "filehelper" && !_cache.ContainsKey(id));

        private void Render()
        {
            _chips.Children.Clear();
            foreach (var id in _items) _chips.Children.Add(BuildChip(id));

            _hint.Visibility = _items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _hint.Text = _emptyHint;
        }

        private Border BuildChip(string id)
        {
            string display;
            string sub;
            if (id == "*")
            {
                display = "全部静音（*）";
                sub = "所有会话";
            }
            else if (id == "filehelper")
            {
                display = "文件传输助手";
                sub = "filehelper";
            }
            else if (!string.IsNullOrEmpty(id) && _cache.TryGetValue(id, out var info))
            {
                display = info.Display;
                sub = id + (info.IsGroup ? " · 群" : "");
            }
            else
            {
                display = string.IsNullOrEmpty(id) ? "（空）" : id;
                sub = "微信名未同步";
            }

            var stack = new StackPanel();
            stack.Children.Add(new TextBlock
            {
                Text = display,
                Foreground = (Brush)FindResource("Text"),
                FontSize = 12,
                TextTrimming = TextTrimming.CharacterEllipsis,
                MaxWidth = 240
            });
            stack.Children.Add(new TextBlock
            {
                Text = sub,
                Style = (Style)FindResource("Small"),
                TextTrimming = TextTrimming.CharacterEllipsis,
                MaxWidth = 240
            });

            var chip = new Border
            {
                CornerRadius = new CornerRadius(5),
                Padding = new Thickness(8, 4, 8, 4),
                Margin = new Thickness(0, 2, 6, 2),
                ToolTip = id,
                Child = stack
            };
            chip.SetResourceReference(Border.BackgroundProperty, "Surface3");
            return chip;
        }

        private void SetError(string text)
        {
            _error.Text = text ?? "";
            _error.Visibility = string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible;
            Status?.Invoke(text ?? "");
        }

        private static List<string> ReadArray(JsonElement v)
        {
            var list = new List<string>();
            if (v.ValueKind != JsonValueKind.Array) return list;
            foreach (var x in v.EnumerateArray())
            {
                if (x.ValueKind != JsonValueKind.String) continue;
                var s = (x.GetString() ?? "").Trim();
                if (s.Length > 0) list.Add(s);
            }
            return list;
        }

        private static string ArrayLiteral(IEnumerable<string> ids)
            => "[" + string.Join(",", ids.Select(i => "\"" + Api.Esc(i) + "\"")) + "]";

        private static string Detail(ApiResult res)
        {
            var raw = (res?.Raw ?? "").Trim();
            if (raw.Length == 0) return res?.Error ?? "";
            raw = raw.Replace("\r", " ").Replace("\n", " ");
            return raw.Length > 120 ? raw.Substring(0, 120) + "…" : raw;
        }

        private static string GetStr(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
                ? (v.GetString() ?? "") : "";
    }
}
