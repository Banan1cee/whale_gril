using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    internal sealed class LocalConfiguration
    {
        private readonly string _root;
        private readonly SemaphoreSlim _gate = new SemaphoreSlim(1, 1);
        private JsonElement _snapshot;
        private DateTime _loadedAt;

        public LocalConfiguration(string root) { _root = root; }

        public async Task<ApiResult> ReadAsync(string path)
        {
            await _gate.WaitAsync();
            try
            {
                if (_snapshot.ValueKind != JsonValueKind.Object || DateTime.UtcNow - _loadedAt > TimeSpan.FromSeconds(2))
                {
                    var node = Path.Combine(_root, "runtime", "node.exe");
                    var info = new ProcessStartInfo
                    {
                        FileName = File.Exists(node) ? node : "node",
                        WorkingDirectory = _root,
                        UseShellExecute = false, CreateNoWindow = true,
                        RedirectStandardOutput = true, RedirectStandardError = true,
                        StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
                    };
                    info.ArgumentList.Add(Path.Combine(_root, "src", "services", "launcherSnapshot.js"));
                    using var process = Process.Start(info);
                    var stdout = process.StandardOutput.ReadToEndAsync();
                    var stderr = process.StandardError.ReadToEndAsync();
                    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8));
                    try { await process.WaitForExitAsync(deadline.Token); }
                    catch (OperationCanceledException) { try { process.Kill(true); } catch { } throw; }
                    var text = await stdout;
                    await stderr;
                    if (process.ExitCode != 0) throw new IOException("无法读取本地配置，请检查配置文件格式与目录权限。");
                    using var doc = JsonDocument.Parse(text);
                    _snapshot = doc.RootElement.Clone();
                    _loadedAt = DateTime.UtcNow;
                }
                if (!_snapshot.TryGetProperty(path, out var payload))
                    return new ApiResult { Ok = false, Error = "此功能需要启动内核。" };
                return new ApiResult { Ok = true, StatusCode = 200, Root = payload.Clone() };
            }
            catch
            {
                return new ApiResult { Ok = false, Error = "读取本地配置失败，请检查配置文件和 Node 运行环境。" };
            }
            finally { _gate.Release(); }
        }
    }
}
