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

        /// <summary>更新过程中的一步：Text 给人看，Percent &lt; 0 表示进度不确定。</summary>
        public sealed class Progress
        {
            public string Text { get; set; } = "";
            public double Percent { get; set; } = -1;
        }

        // 脚本里的中文进度行 → 界面上一句话。按顺序匹配，命中第一个就用。
        private static readonly string[][] Stages =
        {
            new[] { "正在查询 GitHub Release", "检查版本…" },
            new[] { "先试差分", "下载差分补丁…" },
            new[] { "下载中", "下载中…" },
            new[] { "校验通过", "校验通过" },
            new[] { "解压新版", "解压新版…" },
            new[] { "已解压", "解压完成" },
            new[] { "语法检查", "检查新版代码…" },
            new[] { "停止正在运行的鲸鲸", "停止内核…" },
            new[] { "备份 data", "备份数据…" },
            new[] { "备份完成", "备份完成" },
            new[] { "更新 runtime", "更新运行环境…" },
            new[] { "覆盖代码", "覆盖代码…" },
            new[] { "启动器已换成新版", "换启动器…" },
            new[] { "更新完成", "收尾…" },
        };

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
                // 必须异步等：WaitForExit(30000) 会卡在 UI 线程上，点一次检查更新就冻四五秒
                bool exited;
                using (var cts = new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(30)))
                {
                    try
                    {
                        await p.WaitForExitAsync(cts.Token);
                        exited = true;
                    }
                    catch (OperationCanceledException)
                    {
                        exited = false;
                    }
                }
                if (!exited)
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
        /// 正在运行的 exe 不能写，脚本会跳过它、最后用「改名 → 落位」换掉，
        /// 所以这里把当前 exe 文件名告诉脚本（名字不写死，以后改名也照跑）。
        /// 输出是边跑边读的：脚本吐一行进度就回传一次，界面才有得显示。
        /// 返回空串表示成功，否则是失败原因。
        /// </summary>
        public static async Task<string> ApplyAsync(string baseDir, IProgress<Progress> progress = null)
        {
            var script = Path.Combine(baseDir, "scripts", "update.ps1");
            if (!File.Exists(script)) return "没找到 scripts\\update.ps1";
            try
            {
                var exeName = "";
                try { exeName = Path.GetFileName(Environment.ProcessPath ?? ""); } catch { }
                var args = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Yes";
                if (!string.IsNullOrWhiteSpace(exeName)) args += " -ExeName \"" + exeName + "\"";

                var psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = args,
                    WorkingDirectory = baseDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };

                var tail = new StringBuilder();
                var gate = new object();
                using var p = new Process { StartInfo = psi };
                p.OutputDataReceived += (_, e) => OnLine(e.Data, tail, gate, progress);
                p.ErrorDataReceived += (_, e) => OnLine(e.Data, tail, gate, progress);
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();

                // 覆盖可能要下载运行时，给足 10 分钟；等退出必须异步，别卡 UI 线程
                var exit = await Task.Run(() => p.WaitForExit(10 * 60 * 1000));
                if (exit) p.WaitForExit();   // 让异步输出把最后几行吐完
                string text;
                lock (gate) text = tail.ToString();
                if (!exit) return "更新超时（10 分钟），可以再点一次「检查更新」重试";
                if (p.ExitCode != 0)
                {
                    var last = "";
                    foreach (var raw in text.Split('\n'))
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

        private static void OnLine(string line, StringBuilder tail, object gate, IProgress<Progress> progress)
        {
            if (line == null) return;
            lock (gate)
            {
                tail.AppendLine(line);
                if (tail.Length > 40000) tail.Remove(0, tail.Length - 40000);   // 别无限涨
            }
            var step = ParseLine(line);
            if (step != null) progress?.Report(step);
        }

        /// <summary>把脚本的一行输出翻成界面状态；认不出来的行返回 null（保持上一句）。</summary>
        private static Progress ParseLine(string raw)
        {
            var line = (raw ?? "").Trim();
            if (line.Length == 0) return null;

            // 脚本吐的进度行：P 45 ghfast.top 52.1/116.6 MB
            if (line.Length > 2 && line[0] == 'P' && line[1] == ' ')
            {
                var parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 2 && double.TryParse(parts[1], out var pct))
                {
                    var rest = parts.Length > 2 ? string.Join(" ", parts, 2, parts.Length - 2) : "";
                    return new Progress
                    {
                        Percent = pct,
                        Text = "下载中 " + (int)pct + "%" + (rest.Length > 0 ? " · " + rest : ""),
                    };
                }
            }

            foreach (var s in Stages)
            {
                if (line.IndexOf(s[0], StringComparison.OrdinalIgnoreCase) >= 0)
                    return new Progress { Text = s[1], Percent = -1 };
            }
            return null;
        }
    }
}
