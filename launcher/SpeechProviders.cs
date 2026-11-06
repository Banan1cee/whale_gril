using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher;

public sealed class SpeechProfile
{
    public string Model { get; set; }
    public string Voice { get; set; }
    public string Instructions { get; set; } = "";
    public Dictionary<string,string> ModelVoices { get; set; } = new();
}

public static class SpeechProviders
{
    public sealed record Provider(string Id, string Name, string BaseUrl, string KeyUrl)
    { public override string ToString() => Name; }
    public const string CosyModel = "FunAudioLLM/CosyVoice2-0.5B";
    public const string MossModel = "fnlp/MOSS-TTSD-v0.5";
    public const string MiniMaxDefaultVoice = "qiaopi_mengmei";
    static readonly Lazy<BreezeSpeech.Choice[]> MiniMaxVoices = new(() => {
        using var stream = typeof(SpeechProviders).Assembly.GetManifestResourceStream("WhaleLauncher.MiniMaxVoices.json");
        return JsonSerializer.Deserialize<BreezeSpeech.Choice[]>(stream);
    });
    public static readonly Provider[] All = {
        new("breezeblue", "BreezeBlue", BreezeSpeech.BaseUrl, "https://breezeblue.ai/zh/app/developer/api-keys"),
        new("minimax", "MiniMax", "https://api.minimax.cn/v1", "https://platform.minimax.cn/console/keys"),
        new("siliconflow", "硅基流动 SiliconFlow", "https://api.siliconflow.cn/v1", "https://cloud.siliconflow.cn/account/ak")
    };
    public static Provider Get(string id) => All.FirstOrDefault(p => p.Id == id)
        ?? throw new ArgumentException("不支持的语音厂商，请重新选择");
    public static string KeyFile(string root, string id)
    {
        Get(id);
        return Path.Combine(root, "data", id == "breezeblue" ? "voice-send-breeze.key" : "voice-send-" + id + ".key");
    }
    public static SpeechProfile Defaults(string id) => id switch {
        "breezeblue" => new() { Model = BreezeSpeech.DefaultModelId, Voice = BreezeSpeech.DefaultVoiceId },
        "minimax" => new() { Model = "speech-2.8-turbo", Voice = MiniMaxDefaultVoice },
        "siliconflow" => new() { Model = CosyModel, Voice = CosyModel + ":claire" },
        _ => throw new ArgumentException("不支持的语音厂商")
    };
    public static BreezeSpeech.Choice[] Choices(string id, IEnumerable<BreezeSpeech.Choice> options, string selected, bool voices, string model = null)
    {
        if (id == "breezeblue") return BreezeSpeech.Choices(options, selected, voices);
        var defaults = Defaults(id);
        model = string.IsNullOrWhiteSpace(model) ? defaults.Model : model.Trim();
        if(id == "siliconflow" && voices) defaults.Voice = model + ":claire";
        selected = string.IsNullOrWhiteSpace(selected) ? (voices ? defaults.Voice : defaults.Model) : selected.Trim();
        BreezeSpeech.Choice[] presets = id == "minimax"
            ? (voices ? new[] {
                new BreezeSpeech.Choice(defaults.Voice, "俏皮萌妹（普通话）（默认）"),
                new BreezeSpeech.Choice("Chinese (Mandarin)_Gentle_Senior", "温柔学姐"),
                new BreezeSpeech.Choice("male-qn-qingse", "青涩青年")
            } : new[] { new BreezeSpeech.Choice("speech-2.8-turbo", "Speech 2.8 Turbo（默认）"),
                new BreezeSpeech.Choice("speech-2.8-hd", "Speech 2.8 HD"),
                new BreezeSpeech.Choice("speech-2.6-turbo", "Speech 2.6 Turbo"),
                new BreezeSpeech.Choice("speech-2.6-hd", "Speech 2.6 HD"),
                new BreezeSpeech.Choice("speech-02-turbo", "Speech 02 Turbo"),
                new BreezeSpeech.Choice("speech-02-hd", "Speech 02 HD"),
                new BreezeSpeech.Choice("speech-01-turbo", "Speech 01 Turbo"),
                new BreezeSpeech.Choice("speech-01-hd", "Speech 01 HD") })
            : (voices ? new[] { new BreezeSpeech.Choice(model + ":claire", "温柔女声 Claire（默认）"),
                new BreezeSpeech.Choice(model + ":anna", "沉稳女声 Anna"),
                new BreezeSpeech.Choice(model + ":bella", "激情女声 Bella"),
                new BreezeSpeech.Choice(model + ":diana", "欢快女声 Diana"),
                new BreezeSpeech.Choice(model + ":alex", "沉稳男声 Alex"),
                new BreezeSpeech.Choice(model + ":benjamin", "低沉男声 Benjamin"),
                new BreezeSpeech.Choice(model + ":charles", "磁性男声 Charles"),
                new BreezeSpeech.Choice(model + ":david", "欢快男声 David") }
                : new[] { new BreezeSpeech.Choice(CosyModel, "CosyVoice 2（默认）"), new BreezeSpeech.Choice(MossModel, "MOSS-TTSD 0.5 · 中英对话语音") });
        if(id == "minimax" && voices) presets = presets.Concat(MiniMaxVoices.Value).DistinctBy(c => c.Id).ToArray();
        var list = presets.Concat(options ?? Array.Empty<BreezeSpeech.Choice>()).Where(c => !string.IsNullOrWhiteSpace(c.Id)).DistinctBy(c => c.Id).ToList();
        if (!list.Any(c => c.Id == selected)) list.Add(new(selected, "已保存的自定义" + (voices ? "音色" : "模型")));
        return list.ToArray();
    }

    static HttpClient Client() => new(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false })
        { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
    static HttpRequestMessage Request(string id, string key, string path, object body = null)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("请填写 " + Get(id).Name + " Key");
        var request = new HttpRequestMessage(body == null ? HttpMethod.Get : HttpMethod.Post, Get(id).BaseUrl + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key.Trim());
        if (body != null) request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return request;
    }
    public static HttpRequestMessage CreateRequest(string id, string key, string model, string voice, string text, string instructions)
    {
        Get(id);
        if (id == "breezeblue") return BreezeSpeech.CreateRequest(key, model, voice, text, instructions);
        if (string.IsNullOrWhiteSpace(text) || text.Length > 1000) throw new ArgumentException("请输入 1～1000 字");
        if (string.IsNullOrWhiteSpace(model) || string.IsNullOrWhiteSpace(voice)) throw new ArgumentException("请选择模型和音色");
        if (id == "minimax") return Request(id, key, "/t2a_v2", new {
            model, text, stream = false, output_format = "hex",
            voice_setting = new { voice_id = voice, speed = 1, vol = 1, pitch = 0 },
            audio_setting = new { sample_rate = 32000, format = "wav", channel = 1 }
        });
        string input = model == MossModel ? "[S1]" + text
            : string.IsNullOrWhiteSpace(instructions) ? text : instructions.Trim() + "<|endofprompt|>" + text;
        return Request(id, key, "/audio/speech", new {
            model, voice, input,
            response_format = "wav", sample_rate = 32000, stream = false
        });
    }
    static void EnsureBusinessSuccess(JsonElement root)
    {
        if (!root.TryGetProperty("base_resp", out var info) || !info.TryGetProperty("status_code", out var code))
            throw new Exception("MiniMax 返回格式异常");
        if (code.GetInt32() != 0) throw new Exception("MiniMax 业务错误 " + code.GetInt32() + "：请检查 Key 权限、余额和音色");
    }
    static async Task<byte[]> Read(HttpResponseMessage response, int maximum, CancellationToken ct)
    {
        if (response.Content.Headers.ContentLength > maximum) throw new Exception("语音接口响应过大");
        using var source = await response.Content.ReadAsStreamAsync(ct);
        using var output = new MemoryStream();
        var buffer = new byte[16384]; int n;
        while ((n = await source.ReadAsync(buffer, ct)) > 0) {
            if (output.Length + n > maximum) throw new Exception("语音接口响应过大");
            output.Write(buffer, 0, n);
        }
        return output.ToArray();
    }
    public static async Task Generate(string id, string key, string model, string voice, string text, string instructions,
        string file, CancellationToken ct, BreezeSpeech.RequestMetrics metrics = null, TimeSpan? limit = null, HttpClient transport = null)
    {
        Get(id);
        if (id == "breezeblue") { await BreezeSpeech.Generate(key, model, voice, text, instructions, file, ct, metrics, limit, transport); return; }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(limit ?? TimeSpan.FromSeconds(20));
        using var owned = transport == null ? Client() : null;
        metrics ??= new(); var clock = Stopwatch.StartNew(); bool created = false;
        try {
            using var request = CreateRequest(id, key, model, voice, text, instructions);
            using var response = await (transport ?? owned).SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            metrics.HeadersMs = clock.ElapsedMilliseconds; metrics.HttpStatus = (int)response.StatusCode;
            if (!response.IsSuccessStatusCode || response.StatusCode == System.Net.HttpStatusCode.Accepted)
                throw new HttpRequestException(Get(id).Name + " HTTP " + (int)response.StatusCode + "：请检查 Key、余额、模型和音色", null, response.StatusCode);
            var audio = await Read(response, id == "minimax" ? 34 * 1024 * 1024 : 16 * 1024 * 1024, timeout.Token);
            if (id == "minimax") {
                using var json = JsonDocument.Parse(audio); EnsureBusinessSuccess(json.RootElement);
                var hex = json.RootElement.GetProperty("data").GetProperty("audio").GetString();
                if (string.IsNullOrEmpty(hex) || hex.Length > 32 * 1024 * 1024) throw new Exception("MiniMax 未返回有效音频");
                audio = Convert.FromHexString(hex);
            }
            if(id == "siliconflow") DownloadedWave.FinalizeHeader(audio);
            timeout.Token.ThrowIfCancellationRequested();
            using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write)) {
                created = true; await output.WriteAsync(audio, timeout.Token);
            }
            VoiceSendEngine.ValidateWave(file);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) {
            if (created) File.Delete(file);
            throw new TimeoutException(Get(id).Name + " 语音合成超时，尚未开始微信录音");
        }
        catch { if (created) File.Delete(file); throw; }
        finally { metrics.RequestMs = clock.ElapsedMilliseconds; }
    }

    public static async Task<BreezeSpeech.Choice[]> Catalog(string id, string key, bool voices, string search, CancellationToken ct, HttpClient transport = null, string model = null)
    {
        Get(id);
        if (id == "breezeblue") return await BreezeSpeech.Catalog(key, voices, search, ct);
        if (id == "minimax" && !voices) return Choices(id, null, "", false);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(15));
        using var owned = transport == null ? Client() : null;
        using var request = id == "minimax" ? Request(id, key, "/get_voice", new { voice_type = "all" })
            : Request(id, key, voices ? "/audio/voice/list" : "/models?type=audio");
        using var response = await (transport ?? owned).SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException(Get(id).Name + " HTTP " + (int)response.StatusCode, null, response.StatusCode);
        using var json = JsonDocument.Parse(await Read(response, 4 * 1024 * 1024, timeout.Token));
        var list = new List<BreezeSpeech.Choice>();
        if (id == "minimax") {
            EnsureBusinessSuccess(json.RootElement);
            foreach (var group in new[] { "system_voice", "voice_cloning", "voice_generation" }) {
                if (!json.RootElement.TryGetProperty(group, out var entries) || entries.ValueKind != JsonValueKind.Array) continue;
                foreach (var entry in entries.EnumerateArray()) {
                    var voiceId = entry.GetProperty("voice_id").GetString();
                    list.Add(new(voiceId, entry.TryGetProperty("voice_name", out var name) ? name.GetString() : voiceId));
                }
            }
        } else {
            var entries = json.RootElement.GetProperty(voices ? "results" : "data");
            foreach (var entry in entries.EnumerateArray()) {
                if (voices) {
                    if (!entry.TryGetProperty("model", out var m) || m.GetString() != (model ?? CosyModel)) continue;
                    list.Add(new(entry.GetProperty("uri").GetString(), entry.GetProperty("customName").GetString()));
                } else {
                    string modelId=entry.GetProperty("id").GetString();
                    bool tts=modelId == CosyModel || modelId == MossModel
                        || (entry.TryGetProperty("sub_type",out var kind) && kind.GetString()=="text-to-speech");
                    if(tts) list.Add(new(modelId,modelId));
                }
            }
        }
        return list.Where(c => string.IsNullOrWhiteSpace(search) || (c.Name ?? "").Contains(search, StringComparison.OrdinalIgnoreCase) || c.Id.Contains(search, StringComparison.OrdinalIgnoreCase)).ToArray();
    }
    public static async Task<BreezeSpeech.KeyCheck> CheckKey(string id, string key, CancellationToken ct, HttpClient transport = null)
    {
        Get(id);
        if (id == "breezeblue") return await BreezeSpeech.CheckKey(key, ct, transport);
        if (string.IsNullOrWhiteSpace(key)) return new(false, "请先填写 " + Get(id).Name + " Key");
        try {
            await Catalog(id, key, id == "minimax", "", ct, transport);
            return new(true, Get(id).Name + " 连接与鉴权通过（合成仍需额度和模型权限）");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return new(false, "连接超时，请检查网络"); }
        catch (HttpRequestException ex) { return new(false, ex.StatusCode.HasValue ? "API Key 不可用：HTTP " + (int)ex.StatusCode : "网络连接失败"); }
        catch (OperationCanceledException) { throw; }
        catch { return new(false, "API Key 不可用或接口响应异常，请检查账户权限"); }
    }
}
