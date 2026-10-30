using System;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    /// <summary>调用本机内核 HTTP 的小封装。所有页面都用它，别各写一套 HttpClient。</summary>
    public sealed class ApiResult
    {
        public bool Ok;
        public string Error = "";
        public string Raw = "";
        public JsonElement Root;

        public string Str(string name)
            => Root.ValueKind == JsonValueKind.Object && Root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
                ? (v.GetString() ?? "") : "";

        public bool Bool(string name)
            => Root.ValueKind == JsonValueKind.Object && Root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

        public long Long(string name)
        {
            if (Root.ValueKind != JsonValueKind.Object || !Root.TryGetProperty(name, out var v)) return 0;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) return n;
            if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), out var m)) return m;
            return 0;
        }

        public bool Has(string name) => Root.ValueKind == JsonValueKind.Object && Root.TryGetProperty(name, out _);

        public JsonElement Prop(string name)
            => Root.ValueKind == JsonValueKind.Object && Root.TryGetProperty(name, out var v) ? v : default;
    }

    public static class Api
    {
        private static readonly HttpClient Http = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromSeconds(10)
        };

        private static async Task<ApiResult> Wrap(HttpResponseMessage res)
        {
            var text = await res.Content.ReadAsStringAsync();
            var outRes = new ApiResult { Ok = res.IsSuccessStatusCode, Raw = text };
            try
            {
                using var doc = JsonDocument.Parse(text);
                outRes.Root = doc.RootElement.Clone();
                if (outRes.Root.ValueKind == JsonValueKind.Object && outRes.Root.TryGetProperty("ok", out var ok))
                    outRes.Ok = res.IsSuccessStatusCode && ok.ValueKind == JsonValueKind.True;
                if (outRes.Root.ValueKind == JsonValueKind.Object && outRes.Root.TryGetProperty("error", out var er) && er.ValueKind == JsonValueKind.String)
                    outRes.Error = er.GetString() ?? "";
            }
            catch
            {
                // 不是 JSON（比如 404 纯文本），保持 Raw
            }
            return outRes;
        }

        public static async Task<ApiResult> Get(string baseUrl, string path)
        {
            try
            {
                return await Wrap(await Http.GetAsync(baseUrl + path));
            }
            catch (Exception ex)
            {
                return new ApiResult { Ok = false, Error = ex.Message };
            }
        }

        public static async Task<ApiResult> Post(string baseUrl, string path, string json)
        {
            try
            {
                var body = new StringContent(json, Encoding.UTF8, "application/json");
                return await Wrap(await Http.PostAsync(baseUrl + path, body));
            }
            catch (Exception ex)
            {
                return new ApiResult { Ok = false, Error = ex.Message };
            }
        }

        public static string Esc(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "");
        }
    }
}
