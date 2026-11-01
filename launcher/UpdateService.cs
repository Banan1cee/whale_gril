using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    /// <summary>
    /// 检查更新：调安装目录里的 scripts\update.ps1 -Check -Json，只读不落盘。
    /// 真正的下载/覆盖仍由那个脚本做（带 sha256 校验、失败回滚）。
    /// </summary>
    public static class UpdateService
    {
        public sealed class Result
        {
            public bool Ok { get; set; }
            public bool HasUpdate { get; set; }
            public bool Stale { get; set; }       // 远端 tag 比本地还旧：镜像信息滞后
            public string Current { get; set; } = "";
            public string Latest { get; set; } = "";
            public string Error { get; set; } = "";
        }

        /// <summary>跑一次检查。30 秒超时；失败把原因放在 Error 里，不抛。</summary>
        public static async Task<Result> CheckAsync(string baseDir)
        {
            var result = new Result();
            var script = Path.Combine(baseDir, "scripts", "update.ps1");
            if (!File.Exists(script))
            {
                result.Error = "没找到 scripts\\update.ps1";
                return result;
            }

            Process p = null;
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Check -Json",
                    WorkingDirectory = baseDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                p = Process.Start(psi);
                var stdout = p.StandardOutput.ReadToEndAsync();
                var stderr = p.StandardError.ReadToEndAsync();
                var exit = p.WaitForExit(30000);
                if (!exit)
                {
                    try { p.Kill(true); } catch { }
                    result.Error = "检查超时（30 秒）";
                    return result;
                }
                var text = (await stdout) + "\n" + (await stderr);
                return Parse(text);
            }
            catch (Exception ex)
            {
                result.Error = ex.Message;
                return result;
            }
            finally
            {
                try { p?.Dispose(); } catch { }
            }
        }

        /// <summary>从脚本输出里取最后一行 JSON（前面的中文进度行忽略）。</summary>
        private static Result Parse(string text)
        {
            var result = new Result();
            string json = null;
            foreach (var raw in (text ?? "").Split('\n'))
            {
                var line = raw.Trim();
                if (line.StartsWith("{") && line.EndsWith("}")) json = line;
            }
            if (json == null)
            {
                result.Error = "更新脚本没有返回结果";
                return result;
            }
            try
            {
                using var doc = JsonDocument.Parse(json);
                var r = doc.RootElement;
                result.Ok = r.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True;
                result.HasUpdate = r.TryGetProperty("hasUpdate", out var hu) && hu.ValueKind == JsonValueKind.True;
                result.Stale = r.TryGetProperty("stale", out var st) && st.ValueKind == JsonValueKind.True;
                result.Current = Str(r, "current");
                result.Latest = Str(r, "latest");
                result.Error = Str(r, "error");
            }
            catch (Exception ex)
            {
                result.Error = "解析更新结果失败：" + ex.Message;
            }
            return result;
        }

        private static string Str(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
                ? (v.GetString() ?? "") : "";

        /// <summary>
        /// 真正更新：跑 update.ps1 -Yes（脚本自己备份、覆盖、自检、失败回滚）。
        /// 返回空串表示成功，否则是失败原因。
        /// </summary>
        public static async Task<string> ApplyAsync(string baseDir)
        {
            var script = Path.Combine(baseDir, "scripts", "update.ps1");
            if (!File.Exists(script)) return "没找到 scripts\\update.ps1";
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Yes",
                    WorkingDirectory = baseDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                using var p = Process.Start(psi);
                var stdout = p.StandardOutput.ReadToEndAsync();
                var stderr = p.StandardError.ReadToEndAsync();
                // 覆盖可能要下载运行时，给足 10 分钟
                var exit = await Task.Run(() => p.WaitForExit(10 * 60 * 1000));
                var tail = (await stdout) + (await stderr);
                if (!exit) return "更新超时（10 分钟），请打开 一键更新.bat 看进度";
                if (p.ExitCode != 0)
                {
                    var last = "";
                    foreach (var raw in tail.Split('\n'))
                        if (raw.Trim().Length > 0) last = raw.Trim();
                    return "更新失败（退出码 " + p.ExitCode + "）" + (last.Length > 0 ? "：" + last : "");
                }
                return "";
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
        }
    }
}
