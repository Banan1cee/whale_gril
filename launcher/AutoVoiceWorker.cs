using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher;

public sealed class AutoVoiceSettings
{
    public bool Enabled { get; set; }
    public double Probability { get; set; } = 25;
    public bool Groups { get; set; } = true;
    public bool Private { get; set; } = true;
    public string Provider { get; set; } = "breezeblue";
    public string Address { get; set; } = BreezeSpeech.BaseUrl;
    public string Model { get; set; } = BreezeSpeech.DefaultModelId;
    public string Voice { get; set; } = BreezeSpeech.DefaultVoiceId;
    public string Device { get; set; } = "";
    public string Instructions { get; set; } = "";
    public string RecordingHotkey { get; set; } = "Ctrl+Alt";
    public double SynthTimeoutSec { get; set; } = 20;
    public static AutoVoiceSettings Load(string root) => JsonSerializer.Deserialize<AutoVoiceSettings>(File.ReadAllText(Path.Combine(root,"data","voice-send.json")));
    public static bool IsEnabled(string root) { try { return Load(root)?.Enabled == true; } catch { return false; } }
    public static void CancelJobs(string root)
    {
        string directory=Path.Combine(root,"data","voice-send-jobs");
        if(!Directory.Exists(directory))return;
        foreach(string file in Directory.EnumerateFiles(directory,"*.json"))
            if(AutoVoiceWorker.ValidPath(root,file))File.WriteAllText(file+".cancel","cancelled");
    }
}

public static class AutoVoiceWorker
{
    public sealed record Job(string Text, long Hwnd);
    public sealed record Go(string Chat);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    public static bool ValidPath(string root, string file)
    {
        var dir=Path.GetFullPath(Path.Combine(root,"data","voice-send-jobs"));
        return Path.GetDirectoryName(Path.GetFullPath(file)).Equals(dir,StringComparison.OrdinalIgnoreCase)
            && System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(file),"^[a-f0-9]{32}\\.json$");
    }

    public static async Task<int> Run(string root,string path)
    {
        if (!ValidPath(root,path)) return 2;
        bool recording=false; string audio=path+".wav";
        var metrics=new BreezeSpeech.RequestMetrics();
        using var cancel=new CancellationTokenSource(TimeSpan.FromSeconds(200));
        using var monitor=new System.Threading.Timer(_=>{try{if(File.Exists(path+".cancel")||!AutoVoiceSettings.IsEnabled(root))cancel.Cancel();}catch(ObjectDisposedException){}},null,100,100);
        try
        {
            using (new FileStream(path+".claimed",FileMode.CreateNew,FileAccess.Write)) { }
            var info=new FileInfo(path);
            if(DateTime.UtcNow-info.LastWriteTimeUtc>TimeSpan.FromMinutes(3))throw new Exception("任务已过期");
            var job=JsonSerializer.Deserialize<Job>(File.ReadAllText(path));
            var settings=AutoVoiceSettings.Load(root);
            if(!settings.Enabled||settings.Provider!="breezeblue")throw new Exception("自动语音未启用或服务不受支持");
            if(string.IsNullOrWhiteSpace(settings.Device))throw new Exception("尚未选择虚拟声卡");
            var shortcut=RecordingShortcut.Parse(settings.RecordingHotkey);
            var key=BreezeSpeech.LoadKey(Path.Combine(root,"data","voice-send-breeze.key"));
            double seconds=double.IsFinite(settings.SynthTimeoutSec)?Math.Clamp(settings.SynthTimeoutSec,5,90):20;
            await BreezeSpeech.Generate(key,settings.Model,settings.Voice,job.Text,settings.Instructions,audio,cancel.Token,metrics,TimeSpan.FromSeconds(seconds));
            File.WriteAllText(path+".ready","ready");
            var deadline=DateTime.UtcNow.AddSeconds(25);
            while(!File.Exists(path+".go")){cancel.Token.ThrowIfCancellationRequested();if(DateTime.UtcNow>deadline)throw new Exception("桥接没有确认目标会话");await Task.Delay(100,cancel.Token);}
            var go=JsonSerializer.Deserialize<Go>(File.ReadAllText(path+".go"));
            if(!AutoVoiceSettings.Load(root).Enabled)throw new Exception("自动语音已关闭");
            var hwnd=(IntPtr)job.Hwnd;
            ShowWindow(hwnd,9);SetForegroundWindow(hwnd);await Task.Delay(200,cancel.Token);
            var target=VoiceSendEngine.Capture(shortcut.Label);
            if(target.Hwnd!=hwnd||target.Chat!=go.Chat)throw new Exception("目标窗口或会话校验失败");
            // From here on, failure is uncertain: never automatically send text again.
            recording=true;
            await VoiceSendEngine.Play(audio,settings.Device,target,cancel.Token,shortcut.Label);
            File.WriteAllText(path+".result",JsonSerializer.Serialize(new {Status="sent_unconfirmed",metrics.RequestMs,metrics.HeadersMs,metrics.HttpStatus}));
            return 0;
        }
        catch(Exception ex)
        {
            string kind=ex is TimeoutException?"timeout":ex is System.Net.Http.HttpRequestException?(metrics.HttpStatus.HasValue?"http":"network"):"local";
            File.WriteAllText(path+".result",JsonSerializer.Serialize(new {Status=recording?"uncertain":"failed",Error=ex.Message,ErrorKind=kind,metrics.RequestMs,metrics.HeadersMs,metrics.HttpStatus}));
            return recording?3:2;
        }
        finally { try { File.Delete(audio); } catch { } }
    }
}
