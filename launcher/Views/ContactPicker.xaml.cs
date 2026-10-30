using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace WhaleLauncher.Views
{
    /// <summary>联系人（私聊或群）的展示信息。设置页和选择弹窗共用。</summary>
    public class ContactInfo
    {
        public string Wxid { get; set; } = "";
        public string Name { get; set; } = "";
        public string Remark { get; set; } = "";
        public bool IsGroup { get; set; }

        public string Display => !string.IsNullOrWhiteSpace(Name)
            ? Name
            : (!string.IsNullOrWhiteSpace(Remark) ? Remark : Wxid);
    }

    /// <summary>选择弹窗列表里的一行。</summary>
    public sealed class ContactItem : ContactInfo
    {
        public bool IsSelected { get; set; }
        public string Sub => Wxid + (IsGroup ? " · 群聊" : " · 私聊");
        public Visibility GroupBadgeVisibility => IsGroup ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>
    /// 从 /api/wechat/contacts 拉联系人并多选。白名单和静音黑名单共用。
    /// 接口没上线时只显示错误，不崩。
    /// </summary>
    public partial class ContactPicker : Window
    {
        private readonly RuntimeSupervisor _sup;
        private readonly bool _allowAllMute;
        private readonly Dictionary<string, ContactInfo> _known = new Dictionary<string, ContactInfo>();
        private readonly List<string> _chosen = new List<string>();
        private readonly DispatcherTimer _debounce;
        private int _loadSeq;

        public List<string> SelectedIds { get; private set; } = new List<string>();

        public Dictionary<string, ContactInfo> KnownContacts => _known;

        public ContactPicker(RuntimeSupervisor sup, IEnumerable<string> selected,
            IDictionary<string, ContactInfo> known, bool allowAllMute)
        {
            InitializeComponent();
            _sup = sup;
            _allowAllMute = allowAllMute;

            HeaderText.Text = allowAllMute ? "选择要静音的群 / 人" : "选择白名单联系人";
            SubText.Text = allowAllMute
                ? "勾选后这些群或人的消息不会触发她。勾「全部静音（*）」= 屏蔽所有会话。"
                : "白名单用于「主动搭话」：留空 = 只有主人和文件传输助手。";

            if (known != null)
                foreach (var kv in known) _known[kv.Key] = kv.Value;

            if (selected != null)
            {
                foreach (var raw in selected)
                {
                    var id = (raw ?? "").Trim();
                    if (id.Length == 0) continue;
                    if (id == "*") { AllMuteCheck.IsChecked = true; continue; }
                    if (!_chosen.Contains(id)) _chosen.Add(id);
                }
            }

            AllMuteHost.Visibility = allowAllMute ? Visibility.Visible : Visibility.Collapsed;
            AllMuteCheck.Checked += (_, __) => ApplyAllMuteState();
            AllMuteCheck.Unchecked += (_, __) => ApplyAllMuteState();

            _debounce = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(350) };
            _debounce.Tick += async (_, __) =>
            {
                _debounce.Stop();
                await LoadAsync(SearchBox.Text.Trim());
            };

            Loaded += async (_, __) =>
            {
                ApplyAllMuteState();
                UpdateFooter();
                await LoadAsync("");
            };
        }

        private bool AllMuted => _allowAllMute && AllMuteCheck.IsChecked == true;

        private void ApplyAllMuteState()
        {
            var all = AllMuted;
            List.IsEnabled = !all;
            AllMuteHint.Text = all
                ? "已选全部静音：列表里的勾选会被忽略，确定后 group.mutedGroups = [\"*\"]。"
                : "";
            UpdateFooter();
        }

        private async void OnSearchChanged(object sender, TextChangedEventArgs e)
        {
            if (!IsLoaded) return;
            _debounce.Stop();
            _debounce.Start();
        }

        private void OnTypeChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!IsLoaded) return;
            _ = LoadAsync(SearchBox.Text.Trim());
        }

        private async void OnReload(object sender, RoutedEventArgs e)
        {
            _debounce.Stop();
            await LoadAsync(SearchBox.Text.Trim());
        }

        private async System.Threading.Tasks.Task LoadAsync(string q)
        {
            var seq = ++_loadSeq;
            var type = TypeBox.SelectedIndex == 1 ? "user" : (TypeBox.SelectedIndex == 2 ? "group" : "all");
            var path = "/api/wechat/contacts?type=" + type
                       + (q.Length > 0 ? "&q=" + Uri.EscapeDataString(q) : "");

            if (!_sup.NodeRunning)
            {
                ShowState("内核没起，连不上服务器。已勾选的条目不会丢，启动内核后再刷新。", true);
                return;
            }

            if (List.ItemsSource == null) ShowState("正在载入联系人…", false);

            var res = await Api.Get(_sup.Url, path);
            if (seq != _loadSeq) return;   // 有更新的请求，丢掉旧结果

            if (!res.Ok)
            {
                ShowState("联系人接口还没就绪（GET /api/wechat/contacts 失败）。" + Detail(res), true);
                UpdateFooter();
                return;
            }

            var items = new List<ContactItem>();
            var arr = res.Prop("items");
            long updatedAt = 0;
            var ua = res.Prop("updatedAt");
            if (ua.ValueKind == JsonValueKind.Number && ua.TryGetInt64(out var uaVal)) updatedAt = uaVal;

            if (arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var it in arr.EnumerateArray())
                {
                    if (it.ValueKind != JsonValueKind.Object) continue;
                    var wxid = GetStr(it, "wxid");
                    if (wxid.Length == 0) continue;
                    var info = new ContactInfo
                    {
                        Wxid = wxid,
                        Name = GetStr(it, "name"),
                        Remark = GetStr(it, "remark"),
                        IsGroup = it.TryGetProperty("isGroup", out var g) && g.ValueKind == JsonValueKind.True
                    };
                    _known[wxid] = info;
                    items.Add(new ContactItem
                    {
                        Wxid = wxid,
                        Name = info.Name,
                        Remark = info.Remark,
                        IsGroup = info.IsGroup,
                        IsSelected = _chosen.Contains(wxid)
                    });
                }
            }

            List.ItemsSource = items;
            if (items.Count == 0)
            {
                if (updatedAt == 0)
                    ShowState("联系人缓存还没同步（updatedAt = 0）：联系人只在核心启动时扫描一次，重启核心后再打开这个窗口。", false);
                else if (q.Length > 0)
                    ShowState("没有匹配「" + q + "」的联系人。", false);
                else
                    ShowState("联系人列表是空的。", false);
            }
            else
            {
                StateText.Visibility = Visibility.Collapsed;
            }
            UpdateFooter();
        }

        private void OnItemToggled(object sender, RoutedEventArgs e)
        {
            if (!(sender is CheckBox cb) || !(cb.DataContext is ContactItem item)) return;
            var on = cb.IsChecked == true;
            item.IsSelected = on;
            if (on)
            {
                if (!_chosen.Contains(item.Wxid)) _chosen.Add(item.Wxid);
            }
            else
            {
                _chosen.Remove(item.Wxid);
            }
            UpdateFooter();
        }

        private void UpdateFooter()
        {
            if (FootText == null) return;
            FootText.Text = AllMuted
                ? "已选 " + _chosen.Count + " 个（已勾全部静音，将以 * 保存）"
                : "已选 " + _chosen.Count + " 个";
        }

        private void OnOk(object sender, RoutedEventArgs e)
        {
            SelectedIds = AllMuted ? new List<string> { "*" } : new List<string>(_chosen);
            DialogResult = true;
        }

        private void ShowState(string text, bool error)
        {
            List.ItemsSource = null;
            StateText.Text = text ?? "";
            StateText.Foreground = error ? (Brush)FindResource("Bad") : (Brush)FindResource("Dim");
            StateText.Visibility = Visibility.Visible;
        }

        private static string Detail(ApiResult res)
        {
            var raw = (res?.Raw ?? "").Trim();
            if (raw.Length == 0) return res?.Error ?? "";
            raw = raw.Replace("\r", " ").Replace("\n", " ");
            return raw.Length > 120 ? raw.Substring(0, 120) + "…" : raw;
        }

        private static string GetStr(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";
    }
}
