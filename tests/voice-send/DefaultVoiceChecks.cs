using System;
using System.IO;
using System.Linq;
using System.Threading;
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
                var stack=(StackPanel)((ScrollViewer)page.Content).Content;var panel=(StackPanel)stack.Children[2];
                var combos=panel.Children.OfType<ComboBox>().ToArray();
                var models=combos.Single(c=>c.Items.OfType<BreezeSpeech.Choice>().Any(x=>x.Id==BreezeSpeech.DefaultModelId));
                var voices=combos.Single(c=>c.Items.OfType<BreezeSpeech.Choice>().Any(x=>x.Id==BreezeSpeech.DefaultVoiceId));
                Check(((BreezeSpeech.Choice)models.SelectedItem).Id==BreezeSpeech.DefaultModelId);
                Check(((BreezeSpeech.Choice)voices.SelectedItem).Name=="大肥鱼（机灵版）");
                ((CheckBox)stack.Children[1]).IsChecked=true;
                var password=panel.Children.OfType<PasswordBox>().Single();password.Password="fake-unit-test-credential";
                Check(((BreezeSpeech.Choice)models.SelectedItem).Id==BreezeSpeech.DefaultModelId);
                Check(((BreezeSpeech.Choice)voices.SelectedItem).Id==BreezeSpeech.DefaultVoiceId);
                Check(!File.Exists(Path.Combine(root,"data","voice-send-breeze.key")));
                models.SelectedItem=models.Items.OfType<BreezeSpeech.Choice>().Single(c=>c.Id=="breeze-tts-2-multilingual");
                password.Password="another-fake-unit-test-credential";
                Check(((BreezeSpeech.Choice)models.SelectedItem).Id=="breeze-tts-2-multilingual");
                ((CheckBox)stack.Children[1]).IsChecked=false;
            }catch(Exception ex){error=ex;}
        });
        thread.SetApartmentState(ApartmentState.STA);thread.Start();thread.Join();if(error!=null)throw error;
        Console.WriteLine("PASS "+count+" default model, voice, paste and selection preservation checks; no live API or synthesis.");
    }
}
