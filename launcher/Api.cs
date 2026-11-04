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
        public int StatusCode;
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
            var outRes = new ApiResult { Ok = res.IsSuccessStatusCode, StatusCode = (int)res.StatusCode, Raw = text };
            try
            {
                using var doc = JsonDocument.Parse(text);
                outRes.Root = doc.RootElement.Clone();
                if (outRes.Root.ValueKind == JsonValueKind.Object && outRes.Root.TryGetProperty("ok", out var ok))
                    outRes.Ok = res.IsSuccessStatusCode && ok.ValueKind == JsonValueKind.True;
                if (outRes.Root.ValueKind == JsonValueKind.Object && outRes.Root.TryGetProperty("error", out var er) && er.ValueKind == JsonValueKind.String)
                    outRes.Error = er.GetString() ?? "";
                // 老内核（或别的接口）只在 probe 里放一句人话，没有顶层 error：
                // 取出来显示，别让用户对着一整段原始 JSON 猜自己哪里错了。
                if (outRes.Error.Length == 0 && outRes.Root.ValueKind == JsonValueKind.Object
                    && outRes.Root.TryGetProperty("probe", out var probe) && probe.ValueKind == JsonValueKind.Object
                    && probe.TryGetProperty("message", out var pm) && pm.ValueKind == JsonValueKind.String)
                {
                    outRes.Error = pm.GetString() ?? "";
                    if (probe.TryGetProperty("detail", out var pd) && pd.ValueKind == JsonValueKind.String)
                    {
                        var detail = pd.GetString() ?? "";
                        if (detail.Length > 0 && !outRes.Error.Contains(detail))
                            outRes.Error += "（原始错误：" + (detail.Length > 200 ? detail.Substring(0, 200) : detail) + "）";
                    }
                }
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
                using var response = await Http.GetAsync(baseUrl + path);
                return await Wrap(response);
            }
            catch (Exception ex)
            {
                return new ApiResult { Ok = false, Error = FriendlyError(ex) };
            }
        }

        public static async Task<ApiResult> Post(string baseUrl, string path, string json)
        {
            try
            {
                using var body = new StringContent(json, Encoding.UTF8, "application/json");
                using var response = await Http.PostAsync(baseUrl + path, body);
                return await Wrap(response);
            }
            catch (Exception ex)
            {
                return new ApiResult { Ok = false, Error = FriendlyError(ex) };
            }
        }

        /// <summary>
        /// 把 .NET 的原始异常翻成人话。以前内核没起来时，界面直接显示
        /// 「由于目标计算机积极拒绝，无法连接。 (127.0.0.1:8787)」—— 用户只会一脸问号。
        /// 「连接被拒绝」= 一个字节都没发出去，和「超时」是两回事，给的提示也不同。
        /// </summary>
        public static string FriendlyError(Exception ex)
        {
            for (var e = ex; e != null; e = e.InnerException)
            {
                if (e is System.Net.Sockets.SocketException se
                    && se.SocketErrorCode == System.Net.Sockets.SocketError.ConnectionRefused)
                    return "内核没在运行（连接被拒绝）。先点顶栏「启动」，或者直接在分类文件夹里拖图片。";
            }
            return FriendlyError(ex?.Message ?? "");
        }

        public static string FriendlyError(string message)
        {
            var text = (message ?? "").Trim();
            if (text.Length == 0) return "";
            if (text.Contains("积极拒绝") || text.Contains("refused", StringComparison.OrdinalIgnoreCase)
                || text.Contains("No connection could be made", StringComparison.OrdinalIgnoreCase))
                return "内核没在运行（连接被拒绝）。先点顶栏「启动」，或者直接在分类文件夹里拖图片。";
            if (text.Contains("timed out", StringComparison.OrdinalIgnoreCase) || text.Contains("超时")
                || text.Contains("TaskCanceledException", StringComparison.OrdinalIgnoreCase))
                return "内核没响应（可能正在整理图库），等几秒再试；别重复上传。";
            return text;
        }

        public static string Esc(string s)
        {
            if (s == null) return "";
            var json = JsonSerializer.Serialize(s);
            return json.Substring(1, json.Length - 2);
        }
    }
}
