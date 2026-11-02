using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Threading;
using System.Threading;
using System.Security.Cryptography;

namespace WhaleLauncher
{
    public partial class App : Application
    {
        private Mutex _instance;
        private bool _ownsInstance;

        protected override async void OnStartup(StartupEventArgs e)
        {
            if (e.Args.Length == 2 && e.Args[0] == "--voice-reply-job")
            {
                ShutdownMode = ShutdownMode.OnExplicitShutdown;
                int code = 2;
                try { code = await AutoVoiceWorker.Run(AppContext.BaseDirectory, e.Args[1]); }
                finally { Shutdown(code); }
                return;
            }
            // 自更新后重启会带 --replace <pid>：等旧实例真的退出，再去抢单实例锁
            WaitForReplacedInstance();
            CleanupOldExes();

            var identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(AppContext.BaseDirectory.ToUpperInvariant())));
            _instance = new Mutex(false, "Local\\WhaleGirlLauncher-" + identity);
            try { _ownsInstance = _instance.WaitOne(0); }
            catch (AbandonedMutexException) { _ownsInstance = true; }
            if (!_ownsInstance)
            {
                MessageBox.Show("鲸鲸已经在运行，请切回已有窗口。", "鲸鲸");
                Shutdown();
                return;
            }
            base.OnStartup(e);
            Appearance.Load();
            Appearance.ApplyTheme();
            DispatcherUnhandledException += (_, ex) => Crash("UI", ex.Exception);
            AppDomain.CurrentDomain.UnhandledException += (_, ex) => Crash("进程", ex.ExceptionObject as Exception);
            MainWindow = new MainWindow();
            MainWindow.Show();
        }

        protected override void OnExit(ExitEventArgs e)
        {
            if (_ownsInstance) _instance?.ReleaseMutex();
            _instance?.Dispose();
            base.OnExit(e);
        }

        /// <summary>重启时带 --replace &lt;pid&gt;：等旧实例退出再继续，否则会弹「已经在运行」。</summary>
        private static void WaitForReplacedInstance()
        {
            try
            {
                var args = Environment.GetCommandLineArgs();
                for (var i = 1; i + 1 < args.Length; i++)
                {
                    if (!string.Equals(args[i], "--replace", StringComparison.OrdinalIgnoreCase)) continue;
                    if (!int.TryParse(args[i + 1], out var pid)) return;
                    try { Process.GetProcessById(pid).WaitForExit(15000); } catch { }
                    return;
                }
            }
            catch { }
        }

        /// <summary>更新时旧 exe 被改名成 *.old-*，那时它还锁着；下次启动就能删了。</summary>
        private static void CleanupOldExes()
        {
            try
            {
                foreach (var f in Directory.GetFiles(AppContext.BaseDirectory, "*.old-*"))
                {
                    // 上一个实例可能刚退出、句柄还没完全释放，重试几次
                    for (var i = 0; i < 5; i++)
                    {
                        try { File.Delete(f); break; }
                        catch { Thread.Sleep(200); }
                    }
                }
            }
            catch { }
        }

        /// <summary>任何没接住的异常都写进 data\crash.log，别让窗口无声消失。</summary>
        private static void Crash(string where, Exception ex)
        {
            try
            {
                var dir = Path.Combine(AppContext.BaseDirectory, "data");
                Directory.CreateDirectory(dir);
                var sb = new StringBuilder();
                sb.AppendLine("==== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  [" + where + "] ====");
                sb.AppendLine(ex?.ToString() ?? "（没有异常对象）");
                sb.AppendLine();
                File.AppendAllText(Path.Combine(dir, "crash.log"), sb.ToString(), Encoding.UTF8);
            }
            catch { }
        }
    }
}
