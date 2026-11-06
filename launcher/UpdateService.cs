using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
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
        private const string ReleasePage = "https://github.com/Banan1cee/whale_gril/releases/latest";

        /// <summary>
        /// 安装包和校验清单的候选源，顺序就是尝试顺序：GitHub 直连在前，镜像兜底。
        /// 镜像写法照抄 UpdateManifest 那份（前缀 + 原始 GitHub 地址），
        /// 三家与 scripts/update.ps1 历史上用过的一致。
        ///
        /// 为什么下载也要镜像：清单有 4 个源（含两个镜像），所以「检查更新」总能拿到版本号；
        /// 但资产只有 GitHub 一条路，国内直连 github.com 经常 TLS 直接断，
        /// 于是卡在「下载校验清单失败」——明明知道有新版本，却一个字节都下不来。
        /// </summary>
        private static readonly string[] AssetBases =
        {
            "https://github.com/Banan1cee/whale_gril/releases/latest/download",
            "https://gh-proxy.com/https://github.com/Banan1cee/whale_gril/releases/latest/download",
            "https://ghfast.top/https://github.com/Banan1cee/whale_gril/releases/latest/download",
            "https://ghproxy.net/https://github.com/Banan1cee/whale_gril/releases/latest/download",
        };

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

                // 校验清单：4 个源并行拿、哈希必须一致（安全锚）。拿不到才谈下载。
                progress?.Report(new Progress { Text = "读取校验清单…（" + AssetBases.Length + " 个源并行）", Percent = -1 });
                var sums = await FetchSumsAsync(name);
                if (sums.Hash.Length == 0) return Fail(sums.Error);
                if (sums.SourcesHit > 1)
                    progress?.Report(new Progress { Text = "校验清单一致（" + sums.SourcesHit + " 个源）", Percent = -1 });

                var expected = sums.Hash;
                var ok = false;
                var tried = new List<string>();
                foreach (var baseUrl in AssetBases)
                {
                    var label = LabelOf(baseUrl);
                    progress?.Report(new Progress { Text = "下载安装包…（源：" + label + "）", Percent = 0 });
                    if (!await DownloadAsync(baseUrl + "/" + name, setup, progress, label))
                    {
                        tried.Add(label + " 连不上");
                        continue;
                    }

                    var size = new FileInfo(setup).Length;
                    // 被墙 / 被重定向时，GitHub 会回一张 HTML 错误页，只有几百 KB
                    if (size < 100L * 1024 * 1024)
                    {
                        TryDelete(setup);
                        tried.Add(label + " 只回了 " + (size / 1024 / 1024) + " MB（像错误页）");
                        continue;
                    }

                    // 哈希对不上就换下一个源：镜像缓存了旧包也会走到这里，不是直接判死。
                    var actual = await HashAsync(setup);
                    if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                    {
                        TryDelete(setup);
                        tried.Add(label + " 的 SHA256 对不上");
                        continue;
                    }

                    progress?.Report(new Progress { Text = "校验通过（源：" + label + "）", Percent = 100 });
                    ok = true;
                    break;
                }
                if (!ok) return Fail("安装包下载失败：" + string.Join("；", tried));

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

        // ── 校验清单：多源并行 + 一致性仲裁 ──────────────────────────
        // 抄的是 UpdateManifest 的思路（4 个源并行、按 manifest_version 取最大），
        // 但仲裁目标不同：清单是「取最新」，哈希是「必须一致」——
        // 镜像缓存错乱或被投毒时，多源对不上就直接中止，宁可更新不了也不装错包。

        private sealed class SumsResult
        {
            public string Hash = "";
            public string Error = "";
            public int SourcesHit;
        }

        private static async Task<SumsResult> FetchSumsAsync(string fileName)
        {
            var hits = (await Task.WhenAll(AssetBases.Select(b => FetchSumsOneAsync(b, fileName))))
                .Where(h => h != null)
                .ToList();

            if (hits.Count == 0)
                return new SumsResult { Error = "连不上 GitHub，镜像也没拿到 SHA256SUMS.txt" };
            if (hits.Any(h => !string.Equals(h, hits[0], StringComparison.OrdinalIgnoreCase)))
                return new SumsResult { Error = "多个源的 SHA256SUMS.txt 不一致，已中止（可能是镜像缓存错乱或被篡改）" };

            return new SumsResult { Hash = hits[0], SourcesHit = hits.Count };
        }

        /// <summary>某一源上的哈希；拿不到或格式不对都返回 null，让别的源顶上。</summary>
        private static async Task<string> FetchSumsOneAsync(string baseUrl, string fileName)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                var text = await Http.GetStringAsync(baseUrl + "/SHA256SUMS.txt", cts.Token);
                var hash = FindHashIn(text, fileName);
                return hash.Length == 64 ? hash : null;   // 只认 64 位十六进制，别把错误页当哈希
            }
            catch { return null; }
        }

        /// <summary>从 SHA256SUMS.txt（sha256sum 格式：哈希 + 两个空格 + 文件名）里找对应文件的哈希。</summary>
        private static string FindHashIn(string text, string fileName)
        {
            if (string.IsNullOrEmpty(text)) return "";
            foreach (var raw in text.Split('\n'))
            {
                var line = raw.Trim();
                if (line.Length == 0) continue;
                var idx = line.LastIndexOf(' ');
                if (idx <= 0) continue;
                var hash = line.Substring(0, idx).Trim();
                var file = line.Substring(idx + 1).Trim().TrimStart('*');
                if (string.Equals(file, fileName, StringComparison.OrdinalIgnoreCase)) return hash;
            }
            return "";
        }

        // ── 下载：单源内 4 段并发，失败退回单连接 ──────────────────────

        /// <summary>小于这个体积不值得切段：4 段并发对几 MB 的文件只有反效果。</summary>
        private const long SegmentMinBytes = 8L * 1024 * 1024;
        private const int SegmentCount = 4;

        /// <summary>
        /// 下载一个资产：先探服务端支不支持 Range，支持就 4 段并发拉，
        /// 不支持或任何一段失败就退回单连接——宁可慢一点，不要卡在半截。
        /// 失败时删掉半截文件，别让下次误判「已下好」。
        /// </summary>
        private static async Task<bool> DownloadAsync(string url, string path, IProgress<Progress> progress, string label)
        {
            try
            {
                var total = await ProbeLengthAsync(url);
                if (total >= SegmentMinBytes && await DownloadSegmentsAsync(url, path, total, progress, label))
                    return true;
                return await DownloadSingleAsync(url, path, progress, label);
            }
            catch
            {
                TryDelete(path);
                return false;
            }
        }

        /// <summary>用 Range: bytes=0-0 探总长度；只有 206 + Content-Range 才算支持分段。</summary>
        private static async Task<long> ProbeLengthAsync(string url)
        {
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, url);
                req.Headers.Range = new RangeHeaderValue(0, 0);
                using var res = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
                if (res.StatusCode != HttpStatusCode.PartialContent) return -1;
                var range = res.Content.Headers.ContentRange;
                if (range == null || !range.HasLength) return -1;
                return range.Length ?? -1;
            }
            catch { return -1; }
        }

        private static async Task<bool> DownloadSegmentsAsync(string url, string path, long total,
            IProgress<Progress> progress, string label)
        {
            var chunk = total / SegmentCount;
            try
            {
                TryDelete(path);
                // 先按总长度占位：各段按自己的偏移写入，谁先到都不影响结果
                using (var fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite))
                    fs.SetLength(total);

                var done = new long[1];
                var lastPct = new int[1] { -1 };
                var tasks = new Task[SegmentCount];
                for (var i = 0; i < SegmentCount; i++)
                {
                    var start = i * chunk;
                    var end = i == SegmentCount - 1 ? total - 1 : start + chunk - 1;
                    tasks[i] = DownloadSegmentAsync(url, path, start, end, done, lastPct, total, progress, label);
                }
                await Task.WhenAll(tasks);

                if (new FileInfo(path).Length != total) throw new IOException("分段下载长度对不上");
                return true;
            }
            catch
            {
                TryDelete(path);
                return false;
            }
        }

        private static async Task DownloadSegmentAsync(string url, string path, long start, long end,
            long[] done, int[] lastPct, long total, IProgress<Progress> progress, string label)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Range = new RangeHeaderValue(start, end);
            using var res = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
            if (res.StatusCode != HttpStatusCode.PartialContent)
                throw new InvalidOperationException("服务端不支持分段下载");

            await using var src = await res.Content.ReadAsStreamAsync();
            // 每个段开自己的句柄、从自己的偏移写，互不覆盖
            await using var fs = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite);
            fs.Seek(start, SeekOrigin.Begin);

            var buffer = new byte[81920];
            int n;
            while ((n = await src.ReadAsync(buffer, 0, buffer.Length)) > 0)
            {
                await fs.WriteAsync(buffer, 0, n);
                var all = Interlocked.Add(ref done[0], n);
                if (progress == null || total <= 0) continue;
                var pct = (int)(all * 100L / total);
                if (pct == lastPct[0]) continue;   // 每 80KB 报一次会把 UI 刷爆，按整数百分比报
                lastPct[0] = pct;
                Report(progress, pct, all, total, label);
            }
        }

        private static async Task<bool> DownloadSingleAsync(string url, string path,
            IProgress<Progress> progress, string label)
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
                    if (pct == lastPct) continue;
                    lastPct = pct;
                    Report(progress, pct, done, total, label);
                }
                return true;
            }
            catch
            {
                TryDelete(path);
                return false;
            }
        }

        private static void Report(IProgress<Progress> progress, int pct, long done, long total, string label)
        {
            progress.Report(new Progress
            {
                Text = "下载中 " + pct + "% · " + (done / 1048576.0).ToString("F1") + "/" + (total / 1048576.0).ToString("F1") + " MB"
                    + (label.Length > 0 ? " · " + label : ""),
                Percent = pct,
            });
        }

        /// <summary>进度里显示的源名：直连叫 GitHub，镜像取域名（别把整条 URL 塞进状态栏）。</summary>
        private static string LabelOf(string baseUrl)
        {
            if (baseUrl.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase)) return "GitHub";
            var host = baseUrl.Substring("https://".Length);
            var slash = host.IndexOf('/');
            return slash > 0 ? host.Substring(0, slash) : host;
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
