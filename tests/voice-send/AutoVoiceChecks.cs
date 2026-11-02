using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using WhaleLauncher;
static class AutoVoiceChecks
{
 public static async Task Run(string root)
 {
  int count=0;void Check(bool ok){if(!ok)throw new Exception("Automatic voice check failed");count++;}
  var jobs=Path.Combine(root,"data","voice-send-jobs");Directory.CreateDirectory(jobs);
  Check(VoiceSendEngine.CleanChatName("测试群长按鼠标语音输入文字")=="测试群");
  Check(VoiceSendEngine.CleanChatName("测试群")=="测试群");
  var file=Path.Combine(jobs,Guid.NewGuid().ToString("N")+".json");
  Check(AutoVoiceWorker.ValidPath(root,file));Check(!AutoVoiceWorker.ValidPath(root,Path.Combine(root,"outside.json")));
  Check(!AutoVoiceWorker.ValidPath(root,Path.Combine(jobs,"invalid.json")));
  File.WriteAllText(Path.Combine(root,"data","voice-send.json"),"{\"Enabled\":false}");
  File.WriteAllText(file,JsonSerializer.Serialize(new AutoVoiceWorker.Job("模型原本要说的话",123)));
  Check(await AutoVoiceWorker.Run(root,file)==2);
  using var result=JsonDocument.Parse(File.ReadAllText(file+".result"));Check(result.RootElement.GetProperty("Status").GetString()=="failed");
  Check(!File.Exists(file+".ready"));
  Console.WriteLine("PASS "+count+" automatic worker path and disabled-state checks; no UI automation.");
 }
}
