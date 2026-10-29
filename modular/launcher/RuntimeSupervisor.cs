using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    /// <summary>一行日志。Src：K=内核 B=桥接 L=启动器。</summary>
    public sealed class LogLine
    {
        public DateTime At { get; set; }
        public string Src { get; set; }
        public char Level { get; set; }
        public string Text { get; set; }
    }

    /// <summary>一次状态探测的结果。界面只读这个。</summary>
    public sealed class Snapshot
    {
        public bool NodeUp;
        public bool BridgeUp;
        public int Port = 8787;
        public long UptimeSec;
        public string Provider = "";
        public string Model = "";
        public bool HasKey;
        public bool Mock;

        public bool BrOnline;
        public int BrLastSeenSec = -1;
        public bool BrUia;
        public bool BrListener;
        public bool BrRest;
        public bool BrAccountGuard;
        public bool BrAccountOk;
        public string BrAccount = "";
        public string BrAccountNick = "";
        public string BrAccountWhy = "";
        public string BrWindow = "";   // 心跳暂未上报窗口状态，留空显示「未知」

        public int StReceived;
        public int StReplied;
        public int StSent;
        public int StFailed;
        public long StLastMessageAt;
        public string StLastError = "";
    }

    /// <summary>内核（Node）与桥接（Python）的起停、日志、状态探测。界面只调用这里。</summary>
    public sealed class RuntimeSupervisor : IDisposable
    {
        public string BaseDir { get; }
        public string DataDir { get; }
        public string LogPath { get; }
        public event Action<LogLine> Line;

        private Process _node;
        private Process _bridge;
        private readonly HttpClient _http = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromSeconds(2)
        };

        private readonly List<LogLine> _history = new List<LogLine>();
        private readonly object _histLock = new object();
        private const int HistoryCap = 3000;

        public RuntimeSupervisor(string baseDir)
        {
            BaseDir = baseDir;
            DataDir = Path.Combine(baseDir, "data");
            LogPath = Path.Combine(DataDir, "launcher.log");
            foreach (var k in new[] { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy" })
                try { Environment.SetEnvironmentVariable(k, null); } catch { }
        }

        // ── 日志 ────────────────────────────────────────────────
        private static readonly Regex TimePrefix = new Regex(@"^\[(\d{2}:\d{2}:\d{2})\]\s?", RegexOptions.Compiled);

        private static char InferLevel(string s)
        {
            if (string.IsNullOrEmpty(s)) return 'i';
            if (s.IndexOf("Traceback", StringComparison.Ordinal) >= 0) return 'e';
            if (s.StartsWith("E ") || s.StartsWith("[E]") || s.StartsWith("[!]")) return 'w';
            if (s.IndexOf("错误", StringComparison.Ordinal) >= 0 || s.IndexOf("失败", StringComparison.Ordinal) >= 0) return 'w';
            if (s.IndexOf("Error", StringComparison.Ordinal) >= 0 || s.IndexOf("Exception", StringComparison.Ordinal) >= 0) return 'e';
            return 'i';
        }

        private void Emit(string src, string raw)
        {
            var text = raw ?? "";
            var at = DateTime.Now;
            var m = TimePrefix.Match(text);
            if (m.Success)
            {
                if (TimeSpan.TryParse(m.Groups[1].Value, out var ts)) at = DateTime.Today.Add(ts);
                text = text.Substring(m.Length);
            }
            var line = new LogLine { At = at, Src = src, Level = InferLevel(text), Text = text };

            lock (_histLock)
            {
                _history.Add(line);
                if (_history.Count > HistoryCap) _history.RemoveRange(0, _history.Count - HistoryCap);
            }

            AppendFile(LogPath, line);
            if (src == "B") AppendFile(Path.Combine(DataDir, "bridge.log"), line);
            else if (src == "K") AppendFile(Path.Combine(DataDir, "kernel.log"), line);

            Line?.Invoke(line);
        }

        private static void AppendFile(string path, LogLine line)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                var info = new FileInfo(path);
                if (info.Exists && info.Length > 5 * 1024 * 1024)
                {
                    var bak = path + ".1";
                    try { if (File.Exists(bak)) File.Delete(bak); } catch { }
                    try { File.Move(path, bak); } catch { }
                }
                var row = $"{line.At:HH:mm:ss} {line.Src} {line.Level}  {line.Text}{Environment.NewLine}";
                File.AppendAllText(path, row, Encoding.UTF8);
            }
            catch { /* 日志写不了不影响运行 */ }
        }

        public void Say(string text) => Emit("L", text);

        public List<LogLine> History(int max = 5000)
        {
            lock (_histLock)
            {
                var n = Math.Min(max, _history.Count);
                return _history.GetRange(_history.Count - n, n);
            }
        }

        public int HistoryCount { get { lock (_histLock) return _history.Count; } }

        // ── 进程 ────────────────────────────────────────────────
        public bool NodeRunning => _node != null && !_node.HasExited;
        public bool BridgeRunning => _bridge != null && !_bridge.HasExited;

        public int Port
        {
            get
            {
                try
                {
                    var f = Path.Combine(DataDir, "server-port.txt");
                    if (File.Exists(f) && int.TryParse(File.ReadAllText(f).Trim(), out var p) && p > 0 && p < 65536) return p;
                }
                catch { }
                return 8787;
            }
        }

        public string Url => $"http://127.0.0.1:{Port}";

        public void StartNode()
        {
            if (NodeRunning) return;
            var exe = Path.Combine(BaseDir, "runtime", "node.exe");
            if (!File.Exists(exe)) exe = "node";
            _node = Launch(exe, "server.js", "K", "内核");
        }

        public void StartBridge()
        {
            if (BridgeRunning) return;
            var exe = Path.Combine(BaseDir, "runtime", "python", "python.exe");
            if (!File.Exists(exe))
            {
                Say("找不到 runtime\\python\\python.exe，桥接起不来");
                return;
            }
            _bridge = Launch(exe, "-u examples\\wechatauto_bridge.py", "B", "桥接");
        }

        public void StartAll()
        {
            StartNode();
            StartBridge();
        }

        public void RestartBridge()
        {
            Kill(_bridge, "B", "桥接");
            _bridge = null;
            StartBridge();
        }

        private Process Launch(string exe, string args, string src, string what)
        {
            try
            {
                var psi = new ProcessStartInfo(exe, args)
                {
                    WorkingDirectory = BaseDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                foreach (var k in new[] { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy" })
                    psi.Environment.Remove(k);
                psi.Environment["NO_PROXY"] = "127.0.0.1,localhost,::1";
                psi.Environment["PYTHONIOENCODING"] = "utf-8";
                psi.Environment["PYTHONUNBUFFERED"] = "1";
                psi.Environment["PYTHONUTF8"] = "1";

                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                p.OutputDataReceived += (_, e) => { if (e.Data != null) Emit(src, e.Data); };
                p.ErrorDataReceived += (_, e) => { if (e.Data != null) Emit(src, e.Data); };
                p.Exited += (_, __) => Emit(src, $"{what}已退出（code={TryExitCode(p)}）");
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                Say($"已启动{what}（pid={p.Id}）");
                return p;
            }
            catch (Exception ex)
            {
                Say($"启动{what}失败：{ex.Message}");
                return null;
            }
        }

        private static string TryExitCode(Process p)
        {
            try { return p.ExitCode.ToString(); } catch { return "?"; }
        }

        public void StopAll()
        {
            Kill(_bridge, "B", "桥接");
            Kill(_node, "K", "内核");
            _bridge = null;
            _node = null;
        }

        private void Kill(Process p, string src, string what)
        {
            if (p == null) return;
            try
            {
                if (!p.HasExited)
                {
                    p.Kill(entireProcessTree: true);
                    p.WaitForExit(3000);
                    Emit(src, $"已停止{what}");
                }
            }
            catch (Exception ex)
            {
                Say($"停止{what}时出错：{ex.Message}");
            }
        }

        // ── 探测 ────────────────────────────────────────────────
        public async Task<Snapshot> ProbeAsync()
        {
            var s = new Snapshot { NodeUp = NodeRunning, BridgeUp = BridgeRunning, Port = Port };

            if (s.NodeUp)
            {
                try
                {
                    var json = await _http.GetStringAsync(Url + "/api/status");
                    using var doc = JsonDocument.Parse(json);
                    var root = doc.RootElement;
                    s.UptimeSec = Long(root, "uptimeSec");
                    s.Provider = Str(root, "providerLabel");
                    if (string.IsNullOrEmpty(s.Provider)) s.Provider = Str(root, "provider");
                    s.Model = Str(root, "model");
                    s.HasKey = Bool(root, "hasKey");
                    s.Mock = Bool(root, "mock");

                    if (root.TryGetProperty("gateways", out var gws) && gws.ValueKind == JsonValueKind.Array && gws.GetArrayLength() > 0)
                    {
                        var gw = gws[0];
                        if (gw.TryGetProperty("stats", out var st) && st.ValueKind == JsonValueKind.Object)
                        {
                            s.StReceived = (int)Long(st, "received");
                            s.StReplied = (int)Long(st, "replied");
                            s.StSent = (int)Long(st, "sent");
                            s.StFailed = (int)Long(st, "failed");
                            s.StLastMessageAt = Long(st, "lastMessageAt");
                            s.StLastError = Str(st, "lastError");
                        }
                        if (gw.TryGetProperty("bridge", out var br) && br.ValueKind == JsonValueKind.Object)
                        {
                            s.BrOnline = Bool(br, "online");
                            s.BrLastSeenSec = (int)Long(br, "lastSeenSec");
                            s.BrUia = Bool(br, "uia");
                            s.BrListener = Bool(br, "listener");
                            s.BrRest = Bool(br, "rest");
                            s.BrAccount = Str(br, "account");
                            s.BrAccountNick = Str(br, "accountNick");
                            s.BrAccountOk = Bool(br, "accountOk");
                            s.BrAccountWhy = Str(br, "accountWhy");
                            s.BrAccountGuard = Bool(br, "accountGuard");
                            s.BrWindow = Str(br, "window");
                        }
                        s.BridgeUp = s.BridgeUp || s.BrOnline;
                    }
                }
                catch { /* 内核刚起还没监听 */ }
            }

            return s;
        }

        private static string Str(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

        private static bool Bool(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

        private static long Long(JsonElement e, string name)
        {
            if (!e.TryGetProperty(name, out var v)) return 0;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) return n;
            if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), out var m)) return m;
            return 0;
        }

        // ── 主动搭话状态（读桥接写的 care-state.json）────────────
        public sealed class CareState
        {
            public long LastTsMs;
            public int SentToday;
            public bool Due;
            public string Reason = "";
            public int WaitMinutes;
        }

        public CareState ReadCareState()
        {
            var outState = new CareState();
            try
            {
                var f = Path.Combine(DataDir, "care-state.json");
                if (File.Exists(f))
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(f));
                    var root = doc.RootElement;
                    var ts = Long(root, "lastTs");
                    outState.LastTsMs = ts > 0 ? ts * 1000 : 0;
                    var day = Str(root, "day");
                    if (day == DateTime.Now.ToString("yyyy-MM-dd")) outState.SentToday = (int)Long(root, "count");
                }
            }
            catch { }
            return outState;
        }

        public async Task<CareState> QueryCareDueAsync(CareState st)
        {
            try
            {
                var url = $"{Url}/api/care/due?last={st.LastTsMs}&sentToday={st.SentToday}";
                var json = await _http.GetStringAsync(url);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                st.Due = Bool(root, "due");
                st.Reason = Str(root, "reason");
                st.WaitMinutes = (int)Long(root, "waitMinutes");
            }
            catch { }
            return st;
        }

        public void Dispose()
        {
            _http.Dispose();
            StopAll();
        }
    }
}
