using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using WhaleLauncher;
using WhaleLauncher.Views;

static class DefaultVoiceChecks
{
    public static void Run(string directory)
    {
        int count=0;void Check(bool ok){if(!ok)throw new Exception("Default voice preset check failed");count++;}
        var defaults=new AutoVoiceSettings();
        Check(defaults.Model==BreezeSpeech.DefaultModelId&&defaults.Voice=="voc_u3nxkd5578wc");
        var options=BreezeSpeech.Choices(new[]{new BreezeSpeech.Choice("breeze-tts-2","API name")},"",false);
        Check(options.Count(c=>c.Id==BreezeSpeech.DefaultModelId)==1);
        Check(options.First().Name.Contains("默认，中文性能更好"));
        Check(options.Any(c=>c.Id=="breeze-tts-2-multilingual"&&c.Name.Contains("多语言版")));
        Check(BreezeSpeech.Choices(Array.Empty<BreezeSpeech.Choice>(),"voc_saved",true).Any(c=>c.Id=="voc_saved"));
        Check(BreezeSpeech.Choices(null,"",true).Single().Name=="大肥鱼（机灵版）");
        Exception error=null;
        var thread=new Thread(()=>{
            try
            {
                var root=Path.Combine(directory,"default-voice-ui");Directory.CreateDirectory(root);
                using var sup=new RuntimeSupervisor(root);var page=new VoiceSendPage(sup);
                var scroll=All<ScrollViewer>(page).Single(s=>s.Content is StackPanel);
                var body=(StackPanel)scroll.Content;var panel=(StackPanel)body.Children[1];
                var combos=All<ComboBox>(panel).ToArray();
                var models=combos.Single(c=>c.Items.OfType<BreezeSpeech.Choice>().Any(x=>x.Id==BreezeSpeech.DefaultModelId));
                var voices=combos.Single(c=>c.Items.OfType<BreezeSpeech.Choice>().Any(x=>x.Id==BreezeSpeech.DefaultVoiceId));
                Check(((BreezeSpeech.Choice)models.SelectedItem).Id==BreezeSpeech.DefaultModelId);
                Check(((BreezeSpeech.Choice)voices.SelectedItem).Name=="大肥鱼（机灵版）");
                var toggle=All<CheckBox>(body.Children[0]).First(c=>c.Content?.ToString()?.Contains("实验性")==true);
                toggle.IsChecked=true;
                var password=All<PasswordBox>(panel).Single();password.Password="fake-unit-test-credential";
                Check(((BreezeSpeech.Choice)models.SelectedItem).Id==BreezeSpeech.DefaultModelId);
                Check(((BreezeSpeech.Choice)voices.SelectedItem).Id==BreezeSpeech.DefaultVoiceId);
                Check(!File.Exists(Path.Combine(root,"data","voice-send-breeze.key")));
                models.SelectedItem=models.Items.OfType<BreezeSpeech.Choice>().Single(c=>c.Id=="breeze-tts-2-multilingual");
                password.Password="another-fake-unit-test-credential";
                Check(((BreezeSpeech.Choice)models.SelectedItem).Id=="breeze-tts-2-multilingual");
                toggle.IsChecked=false;
            }catch(Exception ex){error=ex;}
        });
        thread.SetApartmentState(ApartmentState.STA);thread.Start();thread.Join();if(error!=null)throw error;
        Console.WriteLine("PASS "+count+" default model, voice, paste and selection preservation checks; no live API or synthesis.");
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
