using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher;

public static class VoiceSendTest
{
    public const string Text = "哈喽哈喽，可以听见我说话么";
    public static async Task<string> Run(string root, CancellationToken ct)
    {
        if (!AutoVoiceSettings.IsEnabled(root)) throw new Exception("请先打开语音发送实验开关");
        ct.ThrowIfCancellationRequested();
        string dir = Path.Combine(root, "data", "voice-send-tests");
        Directory.CreateDirectory(dir);
        string path = Path.Combine(dir, Guid.NewGuid().ToString("N"));
        bool complete = false;
        try
        {
            File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(new { CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }));
            File.Move(path + ".tmp", path + ".json");
            var started = DateTime.UtcNow;
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                if (!AutoVoiceSettings.IsEnabled(root)) throw new OperationCanceledException("语音发送已关闭", ct);
                if (File.Exists(path + ".result"))
                {
                    using var json = JsonDocument.Parse(File.ReadAllText(path + ".result"));
                    complete = true;
                    string state = json.RootElement.GetProperty("Status").GetString();
                    string error = json.RootElement.TryGetProperty("Error", out var e) ? e.GetString() : "";
                    return state == "sent_unconfirmed"
                        ? "测试录音和发送操作已完成，请到文件传输助手试听（尚未确认微信送达）"
                        : state == "uncertain" ? "测试发送结果未确认，请检查文件传输助手；不会自动重发。" + error
                        : "测试发送失败：" + error;
                }
                if (!File.Exists(path + ".claimed") && DateTime.UtcNow - started > TimeSpan.FromSeconds(8))
                    throw new Exception("桥接未接收测试，请启动或重启桥接后再试");
                if (DateTime.UtcNow - started > TimeSpan.FromSeconds(200))
                    throw new Exception("测试超时，已请求取消；请检查文件传输助手，不会自动重发");
                await Task.Delay(100, ct);
            }
        }
        finally
        {
            // Leave cancellation visible to a bridge that already claimed this request.
            if (!complete) File.WriteAllText(path + ".cancel", "cancelled");
            foreach (var suffix in complete ? new[] { ".json", ".tmp", ".claimed", ".result", ".cancel" } : new[] { ".json", ".tmp" })
                try { File.Delete(path + suffix); } catch { }
        }
    }
}
