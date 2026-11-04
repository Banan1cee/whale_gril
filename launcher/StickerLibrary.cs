using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    internal static class StickerLibrary
    {
        public static async Task<ApiResult> Call(string root, string action, string category = "")
        {
            try
            {
                var node = Path.Combine(root, "runtime", "node.exe");
                var start = new ProcessStartInfo(File.Exists(node) ? node : "node")
                {
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    StandardOutputEncoding = Encoding.UTF8
                };
                start.ArgumentList.Add(Path.Combine(root, "src", "services", "stickerLibraryLocal.js"));
                start.ArgumentList.Add(action);
                start.ArgumentList.Add(category);
                using var process = Process.Start(start) ?? throw new IOException("无法启动图库读取程序");
                var output = process.StandardOutput.ReadToEndAsync();
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                try { await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false); }
                catch (OperationCanceledException)
                {
                    try { process.Kill(); }
                    catch (InvalidOperationException) { }
                    return new ApiResult { Error = "读取表情包目录超时" };
                }
                using var document = JsonDocument.Parse(await output.ConfigureAwait(false));
                var result = new ApiResult { Root = document.RootElement.Clone() };
                result.Ok = result.Bool("ok");
                result.Error = result.Str("error");
                return result;
            }
            catch (Exception ex) { return new ApiResult { Error = ex.Message }; }
        }
    }
}
