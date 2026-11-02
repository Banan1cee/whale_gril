using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher;

public static class BreezeSpeech
{
    public const string BaseUrl = "https://api.breeze.blue/v1";
    public sealed record Choice(string Id, string Name) { public override string ToString() => Name + "（" + Id + "）"; }

    public static string LoadKey(string file) => File.Exists(file)
        ? Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(file), null, DataProtectionScope.CurrentUser)) : "";

    public static void SaveKey(string file, string key)
    {
        if (string.IsNullOrWhiteSpace(key)) return; // 留空不覆盖已保存凭据。
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        File.WriteAllBytes(file + ".tmp", ProtectedData.Protect(Encoding.UTF8.GetBytes(key.Trim()), null, DataProtectionScope.CurrentUser));
        File.Move(file + ".tmp", file, true);
    }

    public static HttpRequestMessage CreateRequest(string key, string model, string voice, string text, string instructions)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("请填写 BreezeBlue Key");
        if (!Regex.IsMatch(voice ?? "", @"^[A-Za-z0-9_-]{1,160}$")) throw new ArgumentException("请选择有效的 BreezeBlue voice_id");
        if (string.IsNullOrWhiteSpace(text) || text.Length > 1000) throw new ArgumentException("请输入 1～1000 字");
        var body = new Dictionary<string, object> { ["text"] = text };
        if (!string.IsNullOrWhiteSpace(model)) body["model_id"] = model;
        if (!string.IsNullOrWhiteSpace(instructions)) body["instructions"] = instructions;
        var request = new HttpRequestMessage(HttpMethod.Post, BaseUrl + "/text-to-speech/" + voice + "?output_format=wav&delivery=sync");
        request.Headers.Add("xi-api-key", key.Trim());
        request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return request;
    }

    static HttpClient Client() => new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(90) };

    public sealed record KeyCheck(bool Available, string Message);

    public static async Task<KeyCheck> CheckKey(string key, CancellationToken ct, HttpClient transport = null, TimeSpan? limit = null)
    {
        if (string.IsNullOrWhiteSpace(key)) return new(false, "API Key 不可用：请先填写 Key");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(limit ?? TimeSpan.FromSeconds(15));
        using var owned = transport == null ? Client() : null;
        var client = transport ?? owned;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, BaseUrl + "/models");
            request.Headers.Add("xi-api-key", key.Trim());
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode) return new(false, "API Key 不可用：HTTP " + (int)response.StatusCode);
            var bytes = await response.Content.ReadAsByteArrayAsync(timeout.Token);
            if (bytes.Length > 4 * 1024 * 1024) return new(false, "API Key 不可用：接口响应异常");
            using var json = JsonDocument.Parse(bytes);
            return json.RootElement.ValueKind == JsonValueKind.Array
                ? new(true, "API Key 可用（连接与鉴权通过）") : new(false, "API Key 不可用：接口响应异常");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return new(false, "API Key 不可用：连接超时"); }
        catch (HttpRequestException) { return new(false, "API Key 不可用：网络连接失败"); }
        catch (JsonException) { return new(false, "API Key 不可用：接口响应异常"); }
        catch (FormatException) { return new(false, "API Key 不可用：Key 格式错误"); }
    }

    public static async Task Generate(string key, string model, string voice, string text, string instructions, string file, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(90)); ct = timeout.Token;
        using var client = Client(); using var request = CreateRequest(key, model, voice, text, instructions);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode == System.Net.HttpStatusCode.Accepted) throw new Exception("BreezeBlue 返回异步任务，未取得音频。请检查服务端任务记录后再试，程序不会自动重复扣费请求。");
        if (!response.IsSuccessStatusCode) throw new Exception("BreezeBlue HTTP " + (int)response.StatusCode + "：请检查 Key 权限、余额、模型和音色");
        using var source = await response.Content.ReadAsStreamAsync(ct);
        using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write))
        {
            var buffer = new byte[16384]; long total = 0; int n;
            while ((n = await source.ReadAsync(buffer, ct)) > 0)
            {
                total += n; if (total > 16 * 1024 * 1024) throw new Exception("BreezeBlue 音频超过 16 MB");
                await output.WriteAsync(buffer.AsMemory(0, n), ct);
            }
        }
        VoiceSendEngine.ValidateWave(file);
    }

    public static async Task<Choice[]> Catalog(string key, bool voices, string search, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new Exception("请先填写 BreezeBlue Key");
        using var client = Client(); client.Timeout = TimeSpan.FromSeconds(20);
        using var request = new HttpRequestMessage(HttpMethod.Get, BaseUrl + (voices ? "/voices?page_size=100&search=" + Uri.EscapeDataString(search ?? "") : "/models"));
        request.Headers.Add("xi-api-key", key.Trim());
        using var response = await client.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) throw new Exception("读取 BreezeBlue 列表失败：HTTP " + (int)response.StatusCode);
        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        if (bytes.Length > 4 * 1024 * 1024) throw new Exception("BreezeBlue 列表响应过大");
        using var json = JsonDocument.Parse(bytes);
        var entries = voices ? json.RootElement.GetProperty("voices") : json.RootElement;
        var list = new List<Choice>();
        foreach (var entry in entries.EnumerateArray())
            list.Add(new Choice(entry.GetProperty(voices ? "voice_id" : "model_id").GetString(), entry.GetProperty("name").GetString()));
        return list.ToArray();
    }
}
