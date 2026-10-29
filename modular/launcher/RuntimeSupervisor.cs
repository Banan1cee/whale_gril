using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    /// <summary>内核（Node）与桥接（Python）的起停与状态探测。界面只调用这里。</summary>
    public sealed class RuntimeSupervisor : IDisposable
    {
        public string BaseDir { get; }
        public string DataDir { get; }
        public string LogPath { get; }
        public event Action<string> Log;

        private Process _node;
        private Process _bridge;
        private readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };

        public RuntimeSupervisor(string baseDir)
        {
            BaseDir = baseDir;
            DataDir = Path.Combine(baseDir, "data");
            LogPath = Path.Combine(DataDir, "launcher.log");
        }

        private void Say(string line)
        {
            var text = $"{DateTime.Now:HH:mm:ss}  {line}";
            Log?.Invoke(text);
            try
            {
                Directory.CreateDirectory(DataDir);
                File.AppendAllText(LogPath, text + Environment.NewLine);
            }
            catch { /* 日志写不了不影响运行 */ }
        }

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
            _node = Launch(exe, "server.js", "内核");
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
            _bridge = Launch(exe, "-u examples\\wechatauto_bridge.py", "桥接");
        }

        private Process Launch(string exe, string args, string what)
        {
            try
            {
                var psi = new ProcessStartInfo(exe, args)
                {
                    WorkingDirectory = BaseDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = false,
                    RedirectStandardError = false,
                };
                // 清掉残留代理变量：模型和本机都不该走代理
                foreach (var k in new[] { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy" })
                    psi.Environment.Remove(k);
                psi.Environment["NO_PROXY"] = "127.0.0.1,localhost,::1";
                psi.Environment["TZ"] = "Asia/Shanghai";

                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                p.Exited += (_, __) => Say($"{what}已退出（code={TryExitCode(p)}）");
                p.Start();
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
            Kill(_bridge, "桥接");
            Kill(_node, "内核");
            _bridge = null;
            _node = null;
        }

        private void Kill(Process p, string what)
        {
            if (p == null) return;
            try
            {
                if (!p.HasExited)
                {
                    p.Kill(entireProcessTree: true);
                    p.WaitForExit(3000);
                    Say($"已停止{what}");
                }
            }
            catch (Exception ex)
            {
                Say($"停止{what}时出错：{ex.Message}");
            }
        }

        public sealed class Snapshot
        {
            public bool NodeUp;
            public bool BridgeUp;
            public string Wechat = "未知";
            public string Channel = "";
            public string LastChat = "";
        }

        public async Task<Snapshot> ProbeAsync()
        {
            var s = new Snapshot { NodeUp = NodeRunning, BridgeUp = BridgeRunning };

            if (s.NodeUp)
            {
                try
                {
                    var json = await _http.GetStringAsync(Url + "/api/status");
                    using var doc = JsonDocument.Parse(json);
                    var root = doc.RootElement;
                    if (root.TryGetProperty("bridge", out var br) && br.ValueKind == JsonValueKind.Object)
                    {
                        if (br.TryGetProperty("online", out var on)) s.BridgeUp = s.BridgeUp || on.GetBoolean();
                        if (br.TryGetProperty("uia", out var uia) && uia.ValueKind == JsonValueKind.True) s.Channel = "UIA 正常";
                    }
                }
                catch { /* 内核刚起还没监听 */ }
            }

            try
            {
                var ready = Path.Combine(DataDir, "bridge-ready.json");
                if (File.Exists(ready))
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(ready));
                    if (doc.RootElement.TryGetProperty("account", out var acc) && acc.ValueKind == JsonValueKind.String)
                    {
                        var v = acc.GetString();
                        if (!string.IsNullOrWhiteSpace(v)) s.Wechat = v;
                    }
                }
            }
            catch { }

            try
            {
                var f = Path.Combine(DataDir, "whale.log");
                if (File.Exists(f))
                {
                    using var fs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    using var sr = new StreamReader(fs);
                    var lines = new List<string>();
                    while (!sr.EndOfStream) { lines.Add(sr.ReadLine()); if (lines.Count > 6) lines.RemoveAt(0); }
                    for (int i = lines.Count - 1; i >= 0; i--)
                    {
                        if (lines[i].Contains("收到") || lines[i].Contains("回复"))
                        {
                            s.LastChat = lines[i].Trim();
                            break;
                        }
                    }
                }
            }
            catch { }

            return s;
        }

        public void Dispose()
        {
            _http.Dispose();
            StopAll();
        }
    }
}
