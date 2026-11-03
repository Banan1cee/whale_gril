using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using WhaleLauncher;
using WhaleLauncher.Views;

static class ExperimentalVoiceChecks
{
    public static void Run(string directory)
    {
        int count=0;
        void Check(bool value){if(!value)throw new Exception("Experimental voice check failed");count++;}
        var defaults=new AutoVoiceSettings();Check(!defaults.Enabled);Check(defaults.RecordingHotkey=="Ctrl+Alt");
        Check(RecordingShortcut.Parse("Alt + Control").Label=="Ctrl+Alt");
        Check(RecordingShortcut.Parse("Ctrl+Alt").Keys.SequenceEqual(new ushort[]{0x11,0x12}));
        Check(RecordingShortcut.Parse("control + tab").Label=="Ctrl+Tab");
        Check(RecordingShortcut.Parse("Ctrl+Tab").Keys.SequenceEqual(new ushort[]{0x11,0x09}));
        Check(RecordingShortcut.Parse("Ctrl+Tab").MatchesButton("发语音（按住 Ctrl+Tab）"));
        Check(!RecordingShortcut.Parse("Ctrl+Tab").MatchesButton("发语音（按住 Ctrl+Alt）"));
        Check(RecordingShortcut.Parse("alt+=").Keys.SequenceEqual(new ushort[]{0x12,0xBB}));
        Check(RecordingShortcut.Parse("Ctrl+Shift+F11").Keys.SequenceEqual(new ushort[]{0x11,0x10,0x7A}));
        Check(RecordingShortcut.Parse("F24").Keys.Single()==0x87);
        Check(RecordingShortcut.Parse("Ctrl+Alt").MatchesButton("发语音 ( 按住 Alt + Ctrl )"));
        Check(!RecordingShortcut.Parse("Ctrl+Alt").MatchesButton("发语音 ( 按住 Alt+= )"));
        Check(!RecordingShortcut.Parse("Ctrl+Alt").MatchesButton("语音输入文字(按住Ctrl+Alt)"));
        foreach(var bad in new[]{"", "Ctrl++", "Ctrl+Ctrl", "A+B", "Win+A", "F25"})
        {
            bool rejected=false;try{RecordingShortcut.Parse(bad);}catch(ArgumentException){rejected=true;}Check(rejected);
        }
        Exception error=null;
        var thread=new Thread(()=>{
            try
            {
                var root=Path.Combine(directory,"ui");Directory.CreateDirectory(root);
                using var supervisor=new RuntimeSupervisor(root);
                var page=new VoiceSendPage(supervisor);
                var scroll=All<ScrollViewer>(page).Single(s=>s.Content is StackPanel);
                var body=(StackPanel)scroll.Content;
                var panel=(StackPanel)body.Children[1];
                var toggle=All<CheckBox>(body.Children[0]).First(c=>c.Content?.ToString()?.Contains("实验性")==true);
                Check(toggle.Content.ToString().Contains("实验性"));Check(toggle.IsChecked==false);
                Check(panel.Visibility==Visibility.Collapsed);
                Check(All<ComboBox>(panel).Any(c=>c.IsEditable&&c.Text=="Ctrl+Alt"));
                Check(All<Button>(panel).Any(b=>b.Content.ToString()=="测试 API Key 连接"));
                Check(All<Button>(panel).Any(b=>b.Content.ToString()=="发送测试语音到文件传输助手"));
                toggle.IsChecked=true;
                Check(AutoVoiceSettings.IsEnabled(root));Check(panel.Visibility==Visibility.Visible);
                string jobs=Path.Combine(root,"data","voice-send-jobs");Directory.CreateDirectory(jobs);
                string job=Path.Combine(jobs,Guid.NewGuid().ToString("N")+".json");File.WriteAllText(job,"{}");
                File.WriteAllText(Path.Combine(jobs,"notes.json"),"{}");
                toggle.IsChecked=false;
                Check(!AutoVoiceSettings.IsEnabled(root));Check(panel.Visibility==Visibility.Collapsed);
                Check(File.Exists(job+".cancel"));Check(!File.Exists(Path.Combine(jobs,"notes.json.cancel")));
            }
            catch(Exception ex){error=ex;}
        });
        thread.SetApartmentState(ApartmentState.STA);thread.Start();thread.Join();
        if(error!=null)throw error;
        Console.WriteLine("PASS "+count+" experimental gate, actual UI visibility and custom shortcut checks.");
    }

    // 页面改成卡片分组后控件不再是最外层子节点，这里按逻辑树递归找。
    static IEnumerable<DependencyObject> Descendants(DependencyObject root)
    {
        foreach(var child in LogicalTreeHelper.GetChildren(root))
        {
            if(child is not DependencyObject node)continue;
            yield return node;
            foreach(var nested in Descendants(node))yield return nested;
        }
    }
    static IEnumerable<T> All<T>(DependencyObject root) where T:DependencyObject => Descendants(root).OfType<T>();
}
