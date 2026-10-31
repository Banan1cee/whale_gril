using System;
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

        protected override void OnStartup(StartupEventArgs e)
        {
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
        }

        protected override void OnExit(ExitEventArgs e)
        {
            if (_ownsInstance) _instance?.ReleaseMutex();
            _instance?.Dispose();
            base.OnExit(e);
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
