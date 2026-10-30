using System;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Threading;

namespace WhaleLauncher
{
    public partial class App : Application
    {
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            DispatcherUnhandledException += (_, ex) => Crash("UI", ex.Exception);
            AppDomain.CurrentDomain.UnhandledException += (_, ex) => Crash("进程", ex.ExceptionObject as Exception);
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
