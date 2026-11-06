using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    /// <summary>
    /// 更新落地：两种装法走两条路。
    ///
    /// · 源码版 / 老 zip 装法：目录里有 scripts\update.ps1，仍交给它（备份、覆盖、回滚）。
    /// · 安装版：包里没有 scripts\，改为下载官方安装包 → 校验 SHA256 → 静默覆盖安装。
    ///   安装包资产名由 installer/whale.iss 的 OutputBaseFilename 决定，两处必须一致。
    /// </summary>
    public static class UpdateService
    {
        /// <summary>更新结果。HandedToInstaller=true 表示已经交给安装器，调用方直接退出，别自己再拉起旧 exe。</summary>
        public sealed class ApplyOutcome
        {
            public string Error { get; set; } = "";
            public bool HandedToInstaller { get; set; }
            public bool Ok => Error.Length == 0;
        }

        /// <summary>更新过程中的一步：Text 给人看，Percent &lt; 0 表示进度不确定。</summary>
        public sealed class Progress
        {
            public string Text { get; set; } = "";
            public double Percent { get; set; } = -1;
        }

        // 资产名与 installer/whale.iss 的 OutputBaseFilename=whale-girl-{#AppVersion}-setup 对应
        private const string ReleaseBase = "https://github.com/Banan1cee/whale_gril/releases/latest/download";
        private const string ReleasePage = "https://github.com/Banan1cee/whale_gril/releases/latest";

        // 不调 GitHub API：未认证的 60 次/小时/IP 在共享网络里很容易用完，而且只会更慢。
        // 下载必须跟随系统代理：国内用户基本都挂着代理，直连 176MB 等于必然失败。
        // （检测那边相反的取舍——4 秒超时、失败还能用缓存——所以 UpdateManifest 仍是直连。）
        private static readonly HttpClient Http = new HttpClient(new HttpClientHandler
        {
            UseProxy = true,
            Proxy = System.Net.WebRequest.DefaultWebProxy,
        })
        {
            // 160MB 的安装包在慢网里要几分钟，别用启动检测那个 4 秒的短超时
            Timeout = TimeSpan.FromMinutes(15)
        };

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

        /// <summary>
        /// 更新入口：有 scripts\update.ps1 才走脚本，没有就走安装包覆盖安装。
        /// 返回空 Error 表示成功；HandedToInstaller=true 时调用方应立即退出。
        /// </summary>
        public static async Task<ApplyOutcome> ApplyAsync(string baseDir, string latest, IProgress<Progress> progress = null)
        {
            var script = Path.Combine(baseDir, "scripts", "update.ps1");
            if (File.Exists(script))
                return new ApplyOutcome { Error = await ApplyByScriptAsync(baseDir, script, progress) };
            return await SetupAsync(baseDir, latest, progress);
        }

        /// <summary>
        /// 安装版：下载 whale-girl-{latest}-setup.exe + SHA256SUMS.txt，校验后交给一个
        /// 独立 powershell 去装（启动器必须自退，exe 才换得掉）。
        ///
        /// 用 /SILENT 不用 /VERYSILENT：用户要看得见安装进度。两条 [Run] 都带 skipifsilent，
        /// 所以静默装完不会自己拉起鲸鲸——apply.ps1 最后那句 Start-Process 不能省。
        /// </summary>
        private static async Task<ApplyOutcome> SetupAsync(string baseDir, string latest, IProgress<Progress> progress)
        {
            if (string.IsNullOrWhiteSpace(latest)) return Fail("更新清单里没有版本号");

            try
            {
                var name = "whale-girl-" + latest + "-setup.exe";
                var dir = Path.Combine(Path.GetTempPath(), "whale-update", latest);
                Directory.CreateDirectory(dir);
                var setup = Path.Combine(dir, name);
                var sums = Path.Combine(dir, "SHA256SUMS.txt");

                progress?.Report(new Progress { Text = "读取校验清单…", Percent = -1 });
                if (!await DownloadAsync(ReleaseBase + "/SHA256SUMS.txt", sums, null))
                    return Fail("下载校验清单失败（连不上 GitHub）");

                var expected = FindHash(sums, name);
                if (expected.Length == 0)
                    return Fail("校验清单里没有 " + name + "，这个版本可能还没发布安装包");

                var ok = false;
                for (var attempt = 0; attempt < 2 && !ok; attempt++)
                {
                    progress?.Report(new Progress { Text = "下载安装包…", Percent = 0 });
                    if (!await DownloadAsync(ReleaseBase + "/" + name, setup, progress))
                        return Fail("下载失败（连不上 GitHub）");

                    var size = new FileInfo(setup).Length;
                    // 被墙 / 被重定向时，GitHub 会回一张 HTML 错误页，只有几百 KB
                    if (size < 100L * 1024 * 1024)
                    {
                        TryDelete(setup);
                        if (attempt == 0) continue;
                        return Fail("下载到的安装包只有 " + (size / 1024 / 1024) + " MB，明显是错误页，已删除");
                    }

                    var actual = await HashAsync(setup);
                    if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                    {
                        TryDelete(setup);
                        return Fail("安装包 SHA256 不一致，已删除下载的文件");
                    }
                    ok = true;
                }
                if (!ok) return Fail("下载安装包失败");

                var apply = Path.Combine(dir, "apply.ps1");
                File.WriteAllText(apply, ApplyScript, new UTF8Encoding(false));

                var appExe = Path.Combine(baseDir, "WhaleLauncher.exe");
                try
                {
                    var running = Environment.ProcessPath;
                    if (!string.IsNullOrWhiteSpace(running)) appExe = running;
                }
                catch { }

                var psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + apply + "\""
                        + " -Setup \"" + setup + "\" -AppExe \"" + appExe + "\" -ProcessId " + Environment.ProcessId,
                    // 必须 UseShellExecute：启动器马上要退出，脚本不能挂在它的进程树上
                    UseShellExecute = true,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                };
                Process.Start(psi);

                progress?.Report(new Progress { Text = "正在安装新版本…", Percent = -1 });
                return new ApplyOutcome { HandedToInstaller = true };
            }
            catch (Exception ex)
            {
                return Fail("下载或启动安装包失败：" + ex.Message);
            }
        }

        /// <summary>
        /// 独立进程里的收尾脚本：等启动器退出 → 静默覆盖安装 → 拉起新版启动器。
        /// 不用 Wait-Process -Timeout（Windows PowerShell 5.1 没有这个参数），手写轮询。
        /// </summary>
        private const string ApplyScript =
            "param([string]$Setup, [string]$AppExe, [int]$ProcessId)\n" +
            "$deadline = (Get-Date).AddSeconds(60)\n" +
            "while ((Get-Date) -lt $deadline) {\n" +
            "  if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { break }\n" +
            "  Start-Sleep -Milliseconds 200\n" +
            "}\n" +
            "Start-Process -FilePath $Setup -ArgumentList '/SILENT','/SUPPRESSMSGBOXES','/NORESTART','/CLOSEAPPLICATIONS' -Wait\n" +
            "if (Test-Path $AppExe) { Start-Process -FilePath $AppExe }\n";

        private static ApplyOutcome Fail(string reason)
            => new ApplyOutcome
            {
                HandedToInstaller = false,
                Error = reason + "。可以手动打开 " + ReleasePage + " 下载安装包安装；"
                    + "如果挂了代理，请在系统代理里放行 github.com。"
            };

        /// <summary>从 SHA256SUMS.txt（sha256sum 格式：哈希 + 两个空格 + 文件名）里找对应文件的哈希。</summary>
        private static string FindHash(string sumsPath, string fileName)
        {
            try
            {
                foreach (var raw in File.ReadAllLines(sumsPath))
                {
                    var line = raw.Trim();
                    if (line.Length == 0) continue;
                    var idx = line.LastIndexOf(' ');
                    if (idx <= 0) continue;
                    var hash = line.Substring(0, idx).Trim();
                    var file = line.Substring(idx + 1).Trim().TrimStart('*');
                    if (string.Equals(file, fileName, StringComparison.OrdinalIgnoreCase)) return hash;
                }
            }
            catch { }
            return "";
        }

        /// <summary>边下边报真实字节进度；失败时删掉半截文件，别让下次误判「已下好」。</summary>
        private static async Task<bool> DownloadAsync(string url, string path, IProgress<Progress> progress)
        {
            try
            {
                using var res = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
                if (!res.IsSuccessStatusCode) return false;
                var total = res.Content.Headers.ContentLength ?? -1;
                await using var src = await res.Content.ReadAsStreamAsync();
                await using var dst = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true);
                var buffer = new byte[81920];
                long done = 0;
                var lastPct = -1;
                int n;
                while ((n = await src.ReadAsync(buffer, 0, buffer.Length)) > 0)
                {
                    await dst.WriteAsync(buffer, 0, n);
                    done += n;
                    if (progress == null || total <= 0) continue;
                    var pct = (int)(done * 100L / total);
                    if (pct == lastPct) continue;   // 每 80KB 报一次会把 UI 刷爆，按整数百分比报
                    lastPct = pct;
                    progress.Report(new Progress
                    {
                        Text = "下载中 " + pct + "% · " + (done / 1048576.0).ToString("F1") + "/" + (total / 1048576.0).ToString("F1") + " MB",
                        Percent = pct,
                    });
                }
                return true;
            }
            catch
            {
                TryDelete(path);
                return false;
            }
        }

        private static async Task<string> HashAsync(string path)
        {
            await using var fs = File.OpenRead(path);
            using var sha = SHA256.Create();
            var hash = await sha.ComputeHashAsync(fs);
            return Convert.ToHexString(hash).ToLowerInvariant();
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }

        /// <summary>
        /// 源码版 / 老 zip 装法：跑 update.ps1 -Yes（脚本自己备份、覆盖、自检、失败回滚）。
        /// 正在运行的 exe 不能写，脚本会跳过它、最后用「改名 → 落位」换掉，
        /// 所以这里把当前 exe 文件名告诉脚本（名字不写死，以后改名也照跑）。
        /// 输出是边跑边读的：脚本吐一行进度就回传一次，界面才有得显示。
        /// 返回空串表示成功，否则是失败原因。
        /// </summary>
        private static async Task<string> ApplyByScriptAsync(string baseDir, string script, IProgress<Progress> progress)
        {
            try
            {
                var exeName = "";
                try { exeName = Path.GetFileName(Environment.ProcessPath ?? ""); } catch { }
                // -Force：清单已经判定「该升级」，别让脚本自己再判一次「已是最新」而空转
                var args = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Yes -Force";
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
