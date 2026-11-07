using System;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views;

// 只读、手动触发；不提供未验证的点赞/发布按钮，避免将库返回值误当成送达证据。
public sealed class MomentsPage : UserControl
{
    readonly RuntimeSupervisor sup;
    readonly TextBox keyword = new(), username = new();
    readonly TextBox publisher = new(), comment = new(), replyTo = new();
    readonly ComboBox action = new() { ItemsSource = new[] { "点赞", "取消点赞", "评论", "回复评论" }, SelectedIndex = 0 };
    readonly CheckBox own = new() { Content = "只看自己", Margin = new Thickness(0, 8, 0, 8) };
    readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 12) };
    readonly TextBox output = new() { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true,
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    readonly Button read = new() { Content = "读取最近 20 条", Margin = new Thickness(0, 8, 0, 0) };
    bool reading;
    int viewGeneration;

    public MomentsPage(RuntimeSupervisor supervisor)
    {
        sup = supervisor;
        var page = new Grid { Margin = new Thickness(28, 24, 32, 20) };
        page.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        page.RowDefinitions.Add(new RowDefinition());
        var form = new StackPanel();
        var title = new TextBlock { Text = "朋友圈" };
        title.SetResourceReference(StyleProperty, "H1");
        form.Children.Add(title);
        form.Children.Add(new TextBlock { Text = "读取使用当前桥接账号的本地缓存；未浏览过的动态可能不在缓存中。\n手动互动会操作微信窗口，执行后请在微信确认。发布仅提供文案复制。",
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 12) });
        form.Children.Add(new TextBlock { Text = "正文关键词（可留空）" });
        form.Children.Add(keyword);
        form.Children.Add(new TextBlock { Text = "发布者内部 ID（可留空，不是昵称）", Margin = new Thickness(0, 8, 0, 0) });
        form.Children.Add(username);
        form.Children.Add(own);
        form.Children.Add(read);
        form.Children.Add(new TextBlock { Text = "手动互动（使用上方正文关键词定位，会操作微信窗口）", Margin = new Thickness(0, 12, 0, 4) });
        form.Children.Add(new TextBlock { Text = "发布者准确昵称" }); form.Children.Add(publisher);
        form.Children.Add(action);
        form.Children.Add(new TextBlock { Text = "评论内容 / 发布文案草稿" }); form.Children.Add(comment);
        form.Children.Add(new TextBlock { Text = "被回复者昵称（仅回复评论）" }); form.Children.Add(replyTo);
        var interact = new Button { Content = "执行所选互动" };
        interact.Click += async (_, _) => {
            if (reading) return;
            reading = true; interact.IsEnabled = false;
            try {
                var names = new[] { "like", "unlike", "comment", "reply" };
                var result = await Api.Post(sup.Url, "/api/moments/action", JsonSerializer.Serialize(new {
                    action = names[action.SelectedIndex], publisher = publisher.Text, keyword = keyword.Text,
                    content = comment.Text, replyTo = replyTo.Text
                }));
                if (!result.Ok) { status.Text = result.Error; return; }
                var generation = viewGeneration;
                for (var i = 0; i < 48; i++) {
                    await Task.Delay(2000);
                    if (generation != viewGeneration) return;
                    var state = await Api.Get(sup.Url, "/api/moments/result?id=" + Uri.EscapeDataString(result.Str("id")));
                    if (!state.Ok || state.Str("status") == "failed" || state.Str("status") == "unconfirmed") {
                        status.Text = state.Error; return;
                    }
                    status.Text = "正在执行互动，请勿同时操作微信…";
                }
                status.Text = "操作状态未知，请在微信中确认，不要重复发送。";
            } finally { reading = false; interact.IsEnabled = true; }
        };
        form.Children.Add(interact);
        var draft = new Button { Content = "复制发布文案（到微信手动发表）" };
        draft.Click += (_, _) => { if (!string.IsNullOrWhiteSpace(comment.Text)) { Clipboard.SetText(comment.Text); status.Text = "文案已复制，请在微信朋友圈中粘贴并手动发表。"; } };
        form.Children.Add(draft);
        form.Children.Add(status);
        page.Children.Add(form);
        Grid.SetRow(output, 1);
        page.Children.Add(output);
        Content = page;
        read.Click += async (_, _) => await ReadAsync();
        // 离开页面即清空第三方正文，并让旧请求停止回填。
        Unloaded += (_, _) => { viewGeneration++; output.Clear(); status.Text = ""; };
    }

    async Task ReadAsync()
    {
        if (reading) return;
        reading = true;
        read.IsEnabled = false;
        output.Clear();
        var generation = viewGeneration;
        try
        {
            status.Text = "等候桥接读取，请确保微信和桥接已启动…";
            var response = await Api.Post(sup.Url, "/api/moments/read", JsonSerializer.Serialize(new {
                limit = 20, keyword = keyword.Text, username = username.Text, own = own.IsChecked == true
            }));
            if (generation != viewGeneration) return;
            if (!response.Ok) { status.Text = response.Error; return; }
            var id = response.Str("id");
            for (var i = 0; i < 48; i++)
            {
                await Task.Delay(2000);
                if (generation != viewGeneration) return;
                var result = await Api.Get(sup.Url, "/api/moments/result?id=" + Uri.EscapeDataString(id));
                if (generation != viewGeneration) return;
                if (!result.Ok || result.Str("status") == "failed") { status.Text = result.Error; return; }
                if (result.Str("status") != "done") continue;
                var text = new StringBuilder();
                var count = 0;
                var items = result.Prop("items");
                if (items.ValueKind == JsonValueKind.Array)
                    foreach (var item in items.EnumerateArray())
                    {
                        count++;
                        var name = item.GetProperty("nickname").GetString();
                        var seconds = item.GetProperty("create_time").GetDouble();
                        var time = seconds >= 0 && seconds <= 253402300799
                            ? DateTimeOffset.FromUnixTimeSeconds((long)seconds).ToLocalTime().ToString("yyyy-MM-dd HH:mm") : "时间未知";
                        text.AppendLine($"{name} · {time}");
                        text.AppendLine(item.GetProperty("text").GetString());
                        text.AppendLine($"图片 {item.GetProperty("imageCount")} / 视频 {item.GetProperty("videoCount")}");
                        text.AppendLine();
                    }
                output.Text = text.ToString();
                status.Text = count == 0 ? "本地缓存中没有匹配的动态；这不代表微信服务器没有新动态。" : $"已读取 {count} 条（当前桥接账号的本地缓存）";
                return;
            }
            status.Text = "读取超时；请检查桥接是否正在运行。";
        }
        catch (Exception ex) { if (generation == viewGeneration) status.Text = Api.FriendlyError(ex); }
        finally { reading = false; read.IsEnabled = true; }
    }
}
