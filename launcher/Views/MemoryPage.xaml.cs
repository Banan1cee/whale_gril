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

namespace WhaleLauncher.Views
{
    public sealed class SessionRow
    {
        public string Key { get; set; }
        public string Title { get; set; }
        public string Sub { get; set; }
    }

    public sealed class BackupRow
    {
        public string Name { get; set; }
        public string Label { get; set; }
        public override string ToString() => Label ?? Name ?? "";
    }

    public partial class MemoryPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private List<SessionRow> _sessions = new List<SessionRow>();
        private JsonElement _sessionDetailLoaded;
        private bool _loading;
        private string _backupDir = "";

        public MemoryPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            Loaded += async (_, __) => await RefreshAsync();
        }

        public async Task RefreshAsync()
        {
            if (!_sup.NodeRunning)
            {
                StatusText.Text = "内核没起，读不到记忆。点顶栏 ⏻ 启动。";
                return;
            }
            if (_sessions.Count > 0) return;
            await LoadAllAsync();
        }

        private async Task LoadAllAsync()
        {
            var info = await Api.Get(_sup.Url, "/api/memory/info");
            if (info.Ok)
            {
                var cur = info.Prop("current");
                StatSessions.Text = L(cur, "sessions").ToString();
                StatMessages.Text = L(cur, "messages").ToString();
                StatNotes.Text = L(cur, "notes").ToString();

                var backups = new List<BackupRow>();
                if (info.Prop("backups").ValueKind == JsonValueKind.Array)
                {
                    foreach (var b in info.Prop("backups").EnumerateArray())
                    {
                        var name = S(b, "name");
                        backups.Add(new BackupRow
                        {
                            Name = name,
                            Label = $"{name}   {L(b, "sessions")} 会话 / {L(b, "messages")} 条"
                        });
                    }
                }
                StatBackups.Text = backups.Count.ToString();
                CmbBackups.ItemsSource = backups;
                if (backups.Count > 0) CmbBackups.SelectedIndex = 0;
                else StatusText.Text = "还没有快照。点「立即备份」存一份。";
                _backupDir = info.Str("dir");
            }

            var sess = await Api.Get(_sup.Url, "/api/debug/sessions");
            _sessions = new List<SessionRow>();
            if (sess.Ok && sess.Prop("sessions").ValueKind == JsonValueKind.Array)
            {
                foreach (var s in sess.Prop("sessions").EnumerateArray())
                {
                    var ts = L(s, "lastActiveAt");
                    var when = ts > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(ts).LocalDateTime.ToString("MM-dd HH:mm") : "";
                    var title = S(s, "title");
                    if (string.IsNullOrEmpty(title) || title == "undefined") title = S(s, "key");
                    _sessions.Add(new SessionRow
                    {
                        Key = S(s, "key"),
                        Title = title,
                        Sub = $"{S(s, "platform")}/{S(s, "chatType")} · {L(s, "messageCount")} 条 · {when}"
                    });
                }
            }
            ApplyFilter();

            var feats = await Api.Get(_sup.Url, "/api/features");
            if (feats.Ok && feats.Prop("features").ValueKind == JsonValueKind.Array)
            {
                foreach (var f in feats.Prop("features").EnumerateArray())
                {
                    if (S(f, "key") == "memorySnapshot")
                    {
                        _loading = true;
                        ChkSnapshot.IsChecked = f.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.True;
                        _loading = false;
                    }
                }
            }

            StatusText.Text = _sessions.Count == 0
                ? "还没有任何会话记录。先在微信里跟她说句话，再回来看。"
                : $"共 {_sessions.Count} 个会话。数据目录：{_sup.DataDir}";
        }

        private void ApplyFilter()
        {
            var q = (TxtFilter.Text ?? "").Trim();
            var list = string.IsNullOrEmpty(q)
                ? _sessions
                : _sessions.Where(s => s.Title.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0 ||
                                       s.Key.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
            Sessions.ItemsSource = list;
            if (list.Count > 0) Sessions.SelectedIndex = 0;
        }

        private void OnFilterChanged(object sender, TextChangedEventArgs e) => ApplyFilter();

        private async void OnSessionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!(Sessions.SelectedItem is SessionRow row)) return;
            await LoadDetailAsync(row);
        }

        private async Task LoadDetailAsync(SessionRow row)
        {
            DetailTitle.Text = row.Title;
            DetailSub.Text = row.Key;
            NotesHost.Children.Clear();
            MessagesHost.Children.Clear();
            DetailScroll.Visibility = Visibility.Visible;
            EmptyHint.Visibility = Visibility.Collapsed;

            var res = await Api.Get(_sup.Url, "/api/debug/sessions");
            if (!res.Ok || res.Prop("sessions").ValueKind != JsonValueKind.Array) return;

            foreach (var s in res.Prop("sessions").EnumerateArray())
            {
                if (S(s, "key") != row.Key) continue;

                if (s.TryGetProperty("profiles", out var profs) && profs.ValueKind == JsonValueKind.Array)
                {
                    foreach (var p in profs.EnumerateArray())
                    {
                        var name = S(p, "name");
                        if (string.IsNullOrEmpty(name)) name = S(p, "nickname");
                        if (string.IsNullOrEmpty(name)) name = S(p, "uid");
                        if (p.TryGetProperty("notes", out var notes) && notes.ValueKind == JsonValueKind.Array && notes.GetArrayLength() > 0)
                        {
                            AddLine($"{name}：", (Style)FindResource("Small"), NotesHost);
                            foreach (var n in notes.EnumerateArray())
                                AddLine("  · " + (n.ValueKind == JsonValueKind.String ? n.GetString() : n.ToString()), (Style)FindResource("Value"), NotesHost);
                        }
                    }
                    if (NotesHost.Children.Count == 0)
                        AddLine("这个人还没有笔记。", (Style)FindResource("Small"), NotesHost);
                }

                if (s.TryGetProperty("messages", out var msgs) && msgs.ValueKind == JsonValueKind.Array)
                {
                    foreach (var m in msgs.EnumerateArray())
                    {
                        var who = S(m, "name");
                        if (string.IsNullOrEmpty(who)) who = S(m, "role");
                        var text = S(m, "text");
                        AddLine($"{who}：{text}", (Style)FindResource("Value"), MessagesHost);
                    }
                }
                break;
            }
        }

        private static void AddLine(string text, Style style, StackPanel host)
        {
            host.Children.Add(new TextBlock
            {
                Text = text,
                Style = style,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 4)
            });
        }


        private static string JStr(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
                ? (v.GetString() ?? "") : "";

        private static JsonElement JProp(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v : default;

        // ── 动作 ────────────────────────────────────────────────
        private async void OnReload(object sender, RoutedEventArgs e)
        {
            _sessions.Clear();
            StatusText.Text = "正在读取…";
            await LoadAllAsync();
        }

        private async void OnBackup(object sender, RoutedEventArgs e)
        {
            var res = await Api.Post(_sup.Url, "/api/memory/backup", "{}");
            StatusText.Text = res.Ok
                ? (string.IsNullOrEmpty(res.Str("file")) ? "还没有记忆，不用备份。" : "已备份：" + Path.GetFileName(res.Str("file")))
                : "备份失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            _sessions.Clear();
            await LoadAllAsync();
        }

        private async void OnRestore(object sender, RoutedEventArgs e)
        {
            if (!(CmbBackups.SelectedItem is BackupRow b))
            {
                StatusText.Text = "先选一份快照再恢复。";
                return;
            }
            var confirm = MessageBox.Show($"确定用这份快照覆盖当前记忆？\n\n{b.Label}\n\n覆盖后不可撤销（当前记忆会先被写成一份手动快照）。",
                "恢复记忆", MessageBoxButton.OKCancel, MessageBoxImage.Warning);
            if (confirm != MessageBoxResult.OK) return;

            var res = await Api.Post(_sup.Url, "/api/memory/restore", $"{{\"name\":\"{Api.Esc(b.Name)}\"}}");
            StatusText.Text = res.Ok
                ? "已恢复：" + string.Join("、", ReadArray(res.Prop("restored")))
                : "恢复失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
            _sessions.Clear();
            await LoadAllAsync();
        }

        private static IEnumerable<string> ReadArray(JsonElement e)
        {
            if (e.ValueKind != JsonValueKind.Array) yield break;
            foreach (var x in e.EnumerateArray()) yield return x.ToString();
        }

        private void OnOpenBackupDir(object sender, RoutedEventArgs e)
        {
            try
            {
                var dir = string.IsNullOrEmpty(_backupDir) ? Path.Combine(_sup.DataDir, "backups") : _backupDir;
                Directory.CreateDirectory(dir);
                Process.Start(new ProcessStartInfo(dir) { UseShellExecute = true });
            }
            catch (Exception ex) { StatusText.Text = "打开失败：" + ex.Message; }
        }

        private void OnExport(object sender, RoutedEventArgs e)
        {
            try
            {
                Process.Start(new ProcessStartInfo(_sup.Url + "/api/memory/export") { UseShellExecute = true });
                StatusText.Text = "已在浏览器里下载导出文件（默认不含 Key）。";
            }
            catch (Exception ex) { StatusText.Text = "导出失败：" + ex.Message; }
        }

        private async void OnToggleSnapshot(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            var on = ChkSnapshot.IsChecked == true;
            var res = await Api.Post(_sup.Url, "/api/features", $"{{\"key\":\"memorySnapshot\",\"value\":{(on ? "true" : "false")}}}");
            StatusText.Text = res.Ok ? $"自动快照已{(on ? "开" : "关")}" : "保存失败：" + (res.Error.Length > 0 ? res.Error : res.Raw);
        }

        private static string S(JsonElement e, string n)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

        private static long L(JsonElement e, string n)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(n, out var v)) return 0;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var x)) return x;
            if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), out var y)) return y;
            return 0;
        }
    }
}
