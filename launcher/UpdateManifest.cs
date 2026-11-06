using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    /// <summary>更新策略：正常 / 只提示 / 强制 / 禁止启动。</summary>
    public enum UpdatePolicy
    {
        Ok,
        Warn,
        Force,
        Kill
    }

    /// <summary>release-manifest.json 的本体。字段缺失一律按「不强制」处理，别因为一次写错锁死用户。</summary>
    public sealed class UpdateManifest
    {
        public string Latest { get; set; } = "";
        public DateTimeOffset ReleasedAt { get; set; }
        public double ForceAfterHours { get; set; } = 24;
        public bool? Force { get; set; }
        public string KillBelow { get; set; } = "";
        public string Message { get; set; } = "";
        public string ReleaseNotes { get; set; } = "";
        public int ManifestVersion { get; set; }
    }

    public sealed class ManifestCheck
    {
        public UpdateManifest Manifest { get; set; }
        public UpdatePolicy Policy { get; set; } = UpdatePolicy.Ok;
        public bool HasUpdate { get; set; }
        public bool FromCache { get; set; }
        public string Current { get; set; } = "";
        public string Error { get; set; } = "";
    }

    /// <summary>
    /// 读 release-manifest.json 并判定要不要更新。
    ///
    /// 为什么不用 GitHub API：未认证 60 次/小时/IP，国内还经常不通；而且 API 只回答
    /// 「有没有新版」，回答不了「这一步还让不让用」。清单放在仓库和 Release 资产里，
    /// 你改一行就能刹车，不需要发版。
    ///
    /// 多源同时拉、取 manifest_version 最大的那个：jsDelivr 会给旧缓存，只要别的源给了
    /// 新序号就以新的为准；所有源都给旧的，说明确实还没发新的。
    /// </summary>
    public static class UpdateManifestService
    {
        public static string ReleaseSummary(UpdateManifest manifest)
        {
            var notes = !string.IsNullOrWhiteSpace(manifest?.ReleaseNotes) ? manifest.ReleaseNotes : manifest?.Message;
            if (string.IsNullOrWhiteSpace(notes)) return "该版本暂未提供详细更新说明。";
            var lines = notes.Replace("\r", "").Split('\n')
                .Where(line => !Regex.IsMatch(line, @"^\s{2,}[-*]\s"))
                .Select(line => Regex.Replace(line.Trim(), @"^#{1,6}\s+", ""))
                .Select(line => Regex.Replace(line, @"\[([^\]]+)\]\([^)]*\)", "$1").Replace("`", ""))
                .Where(line => line.Length > 0)
                .Select(line => Regex.Replace(line, @"^[-*]\s+", "• "))
                .Take(10);
            var summary = string.Join("\n", lines);
            return summary.Length > 1400 ? summary.Substring(0, 1400) + "…" : summary;
        }
        private const string Repo = "Banan1cee/whale_girl";

        // 顺序不重要（并行拉），但源要覆盖三种网络：GitHub 直连 / 墙内镜像 / CDN 兜底。
        private static readonly string[] Sources =
        {
            "https://github.com/" + Repo + "/releases/latest/download/release-manifest.json",
            "https://raw.githubusercontent.com/" + Repo + "/main/release-manifest.json",
            "https://gh-proxy.com/https://raw.githubusercontent.com/" + Repo + "/main/release-manifest.json",
            "https://cdn.jsdelivr.net/gh/" + Repo + "@main/release-manifest.json",
        };

        private static readonly HttpClient Http = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            // 启动时不该被网络拖住：拿不到就按缓存 / 放行。
            Timeout = TimeSpan.FromSeconds(4)
        };

        public static string CachePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "WhaleGirl", "update-state.json");

        /// <summary>安装目录里的版本号。优先 package.json（和界面显示同一份），读不到退化到程序集版本。</summary>
        public static string LocalVersion(string baseDir)
        {
            try
            {
                var p = Path.Combine(baseDir, "package.json");
                if (File.Exists(p))
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(p));
                    if (doc.RootElement.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.String)
                    {
                        var s = v.GetString();
                        if (!string.IsNullOrWhiteSpace(s)) return s.Trim();
                    }
                }
            }
            catch { }
            try
            {
                var asm = typeof(UpdateManifestService).Assembly.GetName().Version;
                if (asm != null) return asm.Major + "." + asm.Minor + "." + asm.Build;
            }
            catch { }
            return "";
        }

        /// <summary>拉清单并判定。永不抛：任何异常都变成「拿不到 + 放行」。</summary>
        public static async Task<ManifestCheck> FetchAsync(string baseDir)
        {
            var result = new ManifestCheck();
            result.Current = LocalVersion(baseDir);

            UpdateManifest best = null;
            try
            {
                var all = await Task.WhenAll(Sources.Select(DownloadAsync));
                foreach (var m in all)
                {
                    if (m == null) continue;
                    if (best == null || m.ManifestVersion > best.ManifestVersion) best = m;
                }
            }
            catch { }

            if (best != null)
            {
                result.Manifest = best;
                SaveCache(best);
            }
            else
            {
                var cached = LoadCache();
                if (cached != null)
                {
                    result.Manifest = cached;
                    result.FromCache = true;
                    result.Error = "网络不通，用的是上次缓存的策略";
                }
                else
                {
                    result.Error = "拿不到更新清单（断网 / 被墙）";
                    return result;   // 从没成功过就放行，不拦人
                }
            }

            try
            {
                result.Policy = Decide(result.Current, result.Manifest, DateTimeOffset.UtcNow);
                result.HasUpdate = CompareVersion(result.Current, result.Manifest.Latest) < 0;
            }
            catch (Exception ex)
            {
                // 清单写错时降级成「只提示」：宁可少拦，不能把所有人关在门外
                result.Policy = UpdatePolicy.Warn;
                result.Error = "清单解析异常：" + ex.Message;
            }
            return result;
        }

        /// <summary>
        /// 判定顺序：已是最新 → 正常；低于熔断线 → 禁止启动；显式 force → 强制；
        /// 显式 force=false → 只提示；否则看发布时间是否超过时间闸。
        /// </summary>
        public static UpdatePolicy Decide(string local, UpdateManifest m, DateTimeOffset now)
        {
            if (m == null || string.IsNullOrWhiteSpace(m.Latest)) return UpdatePolicy.Ok;
            if (string.IsNullOrWhiteSpace(local)) return UpdatePolicy.Ok;   // 版本号都读不到，别猜
            if (CompareVersion(local, m.Latest) >= 0) return UpdatePolicy.Ok;

            if (!string.IsNullOrWhiteSpace(m.KillBelow) && CompareVersion(local, m.KillBelow) < 0)
                return UpdatePolicy.Kill;

            if (m.Force == true) return UpdatePolicy.Force;
            if (m.Force == false) return UpdatePolicy.Warn;

            // released_at 解析不出来 → 当成「还没到点」，只提示
            if (m.ReleasedAt == default) return UpdatePolicy.Warn;
            var due = m.ReleasedAt.AddHours(Math.Max(0, m.ForceAfterHours));
            return now >= due ? UpdatePolicy.Force : UpdatePolicy.Warn;
        }

        /// <summary>逐段数值比较，3.9 &lt; 3.64。移植 scripts/update.ps1 的 Compare-Ver 语义。</summary>
        public static int CompareVersion(string a, string b)
        {
            var x = VersionParts(a);
            var y = VersionParts(b);
            for (var i = 0; i < 4; i++)
            {
                if (x[i] > y[i]) return 1;
                if (x[i] < y[i]) return -1;
            }
            return 0;
        }

        private static int[] VersionParts(string v)
        {
            var parts = new int[4];
            if (string.IsNullOrWhiteSpace(v)) return parts;
            var s = v.Trim().TrimStart('v', 'V');
            var idx = 0;
            foreach (var piece in s.Split(new[] { '.', '-', '+', '_', ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (idx >= 4) break;
                var digits = new string(piece.TakeWhile(char.IsDigit).ToArray());
                if (digits.Length == 0) continue;
                if (int.TryParse(digits, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n))
                    parts[idx++] = n;
            }
            return parts;
        }

        private static async Task<UpdateManifest> DownloadAsync(string url)
        {
            try
            {
                using var res = await Http.GetAsync(url);
                if (!res.IsSuccessStatusCode) return null;
                var text = await res.Content.ReadAsStringAsync();
                return Parse(text);
            }
            catch
            {
                return null;
            }
        }

        private static UpdateManifest Parse(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return null;
            using var doc = JsonDocument.Parse(text);
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return null;

            var m = new UpdateManifest { Latest = Str(r, "latest") };
            if (string.IsNullOrWhiteSpace(m.Latest)) return null;

            if (r.TryGetProperty("released_at", out var ra) && ra.ValueKind == JsonValueKind.String
                && DateTimeOffset.TryParse(ra.GetString(), CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal, out var when))
                m.ReleasedAt = when;

            if (r.TryGetProperty("force_after_hours", out var fh))
            {
                if (fh.ValueKind == JsonValueKind.Number && fh.TryGetDouble(out var h)) m.ForceAfterHours = h;
                else if (fh.ValueKind == JsonValueKind.String && double.TryParse(fh.GetString(), out var hs)) m.ForceAfterHours = hs;
            }

            if (r.TryGetProperty("force", out var f))
            {
                if (f.ValueKind == JsonValueKind.True) m.Force = true;
                else if (f.ValueKind == JsonValueKind.False) m.Force = false;
                else m.Force = null;   // null / 缺省 = 按时间闸
            }

            m.KillBelow = Str(r, "kill_below");
            m.Message = Str(r, "message");
            m.ReleaseNotes = Str(r, "release_notes");
            if (r.TryGetProperty("manifest_version", out var mv) && mv.ValueKind == JsonValueKind.Number && mv.TryGetInt32(out var i))
                m.ManifestVersion = i;
            return m;
        }

        private static string Str(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

        // ── 缓存：断网时用上次成功拿到的策略，而不是「什么都拿不到就放行」 ──

        private static void SaveCache(UpdateManifest m)
        {
            try
            {
                var dir = Path.GetDirectoryName(CachePath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                var obj = new
                {
                    latest = m.Latest,
                    released_at = m.ReleasedAt == default ? "" : m.ReleasedAt.ToString("o", CultureInfo.InvariantCulture),
                    force_after_hours = m.ForceAfterHours,
                    force = m.Force,
                    kill_below = m.KillBelow,
                    message = m.Message,
                    release_notes = m.ReleaseNotes,
                    manifest_version = m.ManifestVersion,
                    cached_at = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                };
                File.WriteAllText(CachePath, JsonSerializer.Serialize(obj));
            }
            catch { }
        }

        private static UpdateManifest LoadCache()
        {
            try
            {
                if (!File.Exists(CachePath)) return null;
                return Parse(File.ReadAllText(CachePath));
            }
            catch
            {
                return null;
            }
        }
    }
}
