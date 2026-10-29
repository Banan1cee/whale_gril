using System;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;

namespace WhaleLauncher
{
    public partial class MainWindow : Window
    {
        private readonly RuntimeSupervisor _sup;
        private readonly DispatcherTimer _timer;
        private bool _busy;

        public MainWindow()
        {
            InitializeComponent();

            var dir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            _sup = new RuntimeSupervisor(dir);
            _sup.Log += AppendLog;

            var versionPath = Path.Combine(dir, "package.json");
            if (File.Exists(versionPath))
            {
                try
                {
                    var text = File.ReadAllText(versionPath);
                    var m = System.Text.RegularExpressions.Regex.Match(text, "\"version\"\\s*:\\s*\"([^\"]+)\"");
                    if (m.Success) VersionText.Text = "v" + m.Groups[1].Value + "-alpha";
                }
                catch { }
            }

            AppendLog("启动器就绪");
            AppendLog("安装目录：" + dir);

            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
            _timer.Tick += async (_, __) => await RefreshAsync();
            _timer.Start();
            Loaded += async (_, __) => await RefreshAsync();
            Closed += (_, __) => _sup.Dispose();
        }

        private void AppendLog(string line) => LogBox.AppendText(line + Environment.NewLine);

        private async void OnStart(object sender, RoutedEventArgs e)
        {
            if (_busy) return;
            _busy = true;
            try
            {
                BtnStart.IsEnabled = false;
                AppendLog("— 启动中 —");
                _sup.StartNode();
                await System.Threading.Tasks.Task.Delay(1200);
                _sup.StartBridge();
                await RefreshAsync();
            }
            finally
            {
                BtnStart.IsEnabled = true;
                _busy = false;
            }
        }

        private async void OnStop(object sender, RoutedEventArgs e)
        {
            AppendLog("— 停止中 —");
            _sup.StopAll();
            await RefreshAsync();
        }

        private void OnOpen(object sender, RoutedEventArgs e)
        {
            try
            {
                Process.Start(new ProcessStartInfo(_sup.Url) { UseShellExecute = true });
                AppendLog("已在浏览器打开 " + _sup.Url);
            }
            catch (Exception ex)
            {
                AppendLog("打不开控制台：" + ex.Message);
            }
        }

        private async System.Threading.Tasks.Task RefreshAsync()
        {
            try
            {
                var s = await _sup.ProbeAsync();

                DotNode.Fill = s.NodeUp ? (Brush)FindResource("Ok") : (Brush)FindResource("Idle");
                TextNode.Text = s.NodeUp ? $"在线 · 端口 {_sup.Port}" : "未启动";

                DotBridge.Fill = s.BridgeUp ? (Brush)FindResource("Ok") : (s.NodeUp ? (Brush)FindResource("Warn") : (Brush)FindResource("Idle"));
                TextBridge.Text = s.BridgeUp ? "在线" : (s.NodeUp ? "未连上" : "未启动");

                DotWechat.Fill = s.BridgeUp ? (Brush)FindResource("Ok") : (Brush)FindResource("Idle");
                TextWechat.Text = s.Wechat;

                TextChannel.Text = string.IsNullOrEmpty(s.Channel) ? "—" : s.Channel;
                if (!string.IsNullOrEmpty(s.LastChat)) TextLast.Text = s.LastChat;

                BtnStop.IsEnabled = s.NodeUp || s.BridgeUp;
            }
            catch (Exception ex)
            {
                AppendLog("刷新状态出错：" + ex.Message);
            }
        }
    }
}
