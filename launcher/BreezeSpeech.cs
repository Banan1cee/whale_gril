using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
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
    public const string DefaultModelId = "breeze-tts-2";
    public const string DefaultVoiceId = "voc_u3nxkd5578wc";
    public const string DefaultVoiceName = "大肥鱼（机灵版）";
    public sealed record Choice(string Id, string Name) { public override string ToString() => Name; }
    public static string ModelName(string id,string name) => id switch {
        DefaultModelId => "Breeze TTS 2 · 中英双语版（默认，中文性能更好）",
        "breeze-tts-2-multilingual" => "Breeze TTS 2 · 多语言版",
        _ => name
    };
    public static string SelectionId(string value,bool voices) => string.IsNullOrWhiteSpace(value)
        ? (voices?DefaultVoiceId:DefaultModelId) : value.Trim();
    public static Choice[] Choices(IEnumerable<Choice> options,string selected,bool voices)
    {
        selected=SelectionId(selected,voices);
        var presets=voices?new[]{new Choice(DefaultVoiceId,DefaultVoiceName)}:new[]{
            new Choice(DefaultModelId,ModelName(DefaultModelId,"")),
            new Choice("breeze-tts-2-multilingual",ModelName("breeze-tts-2-multilingual",""))};
        var list=presets.Concat(options??Array.Empty<Choice>()).Where(c=>!string.IsNullOrWhiteSpace(c.Id))
            .Select(c=>new Choice(c.Id,voices?(c.Id==DefaultVoiceId?DefaultVoiceName:c.Name):ModelName(c.Id,c.Name)))
            .DistinctBy(c=>c.Id).ToList();
        if(!list.Any(c=>c.Id==selected))list.Add(new Choice(selected,voices?"已保存的自定义音色":"已保存的自定义模型"));
        return list.ToArray();
    }

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

    // UseProxy = false：这台机器的 HTTP_PROXY 指向本地 Clash（127.0.0.1:7897），
    // .NET 的 HttpClient 会读环境变量走代理 —— 实测同一条合成请求：
    // 走代理 6 分钟没回来，直连 41 秒拿到 wav。语音接口是国内服务，不需要代理。
    // HTTP/1.1 连 api.breeze.blue 建连就失败（20 秒 ConnectTimeout）；实测 HTTP/2 能过：
    // 直连 12.9 秒拿到 153KB wav，走本地代理 2.7 秒。所以强制 HTTP/2，并绕开 Clash（国内接口）。
    static HttpClient Client() => new(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false })
    {
        Timeout = TimeSpan.FromSeconds(90),
        DefaultRequestVersion = System.Net.HttpVersion.Version20,
        DefaultVersionPolicy = System.Net.Http.HttpVersionPolicy.RequestVersionOrLower,
    };

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

    public sealed class RequestMetrics
    {
        public long RequestMs { get; set; }
        public long? HeadersMs { get; set; }
        public int? HttpStatus { get; set; }
    }

    public static async Task Generate(string key, string model, string voice, string text, string instructions, string file, CancellationToken ct,
        RequestMetrics metrics = null, TimeSpan? limit = null, HttpClient transport = null)
    {
        var caller = ct;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(limit ?? TimeSpan.FromSeconds(20)); ct = timeout.Token;
        using var owned = transport == null ? Client() : null;
        var client = transport ?? owned;
        if (owned != null) owned.Timeout = Timeout.InfiniteTimeSpan; // 合成时限统一由上面的取消令牌控制。
        metrics ??= new();
        var clock = Stopwatch.StartNew();
        try {
        using var request = CreateRequest(key, model, voice, text, instructions);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        metrics.HeadersMs = clock.ElapsedMilliseconds; metrics.HttpStatus = (int)response.StatusCode;
        if (response.StatusCode == System.Net.HttpStatusCode.Accepted) throw new Exception("BreezeBlue 返回异步任务，未取得音频。请检查服务端任务记录后再试，程序不会自动重复扣费请求。");
        if (!response.IsSuccessStatusCode) throw new HttpRequestException("BreezeBlue HTTP " + (int)response.StatusCode + "：请检查 Key 权限、余额、模型和音色", null, response.StatusCode);
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
        catch (OperationCanceledException) when (!caller.IsCancellationRequested)
        { throw new TimeoutException("BreezeBlue 语音合成超时，尚未开始微信录音"); }
        finally { metrics.RequestMs = clock.ElapsedMilliseconds; }
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
        {
            var id=entry.GetProperty(voices ? "voice_id" : "model_id").GetString();
            var name=entry.GetProperty("name").GetString();
            list.Add(new Choice(id,voices?name:ModelName(id,name)));
        }
        return list.ToArray();
    }
}
