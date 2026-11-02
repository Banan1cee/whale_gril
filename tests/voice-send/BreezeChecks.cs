using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using WhaleLauncher;

static class BreezeChecks
{
    public static async Task Run(string directory)
    {
        int count=0;
        void Assert(bool value) { if(!value) throw new Exception("Breeze contract check failed"); count++; }
        using var request=BreezeSpeech.CreateRequest("test-only-key","breeze-tts-2","voc_test","测试","温柔地说");
        Assert(request.RequestUri.Host=="api.breeze.blue");
        Assert(request.RequestUri.AbsolutePath=="/v1/text-to-speech/voc_test");
        Assert(request.RequestUri.Query.Contains("output_format=wav")&&request.RequestUri.Query.Contains("delivery=sync"));
        Assert(request.Headers.Contains("xi-api-key")&&request.Headers.Authorization==null);
        using var json=JsonDocument.Parse(await request.Content.ReadAsStringAsync());
        Assert(json.RootElement.GetProperty("text").GetString()=="测试");
        Assert(json.RootElement.GetProperty("model_id").GetString()=="breeze-tts-2");
        Assert(json.RootElement.GetProperty("instructions").GetString()=="温柔地说");
        Assert(!json.RootElement.TryGetProperty("input",out _));
        bool rejected=false;
        try { using var invalid=BreezeSpeech.CreateRequest("test","model","../other","测试",""); } catch(ArgumentException) { rejected=true; }
        Assert(rejected);
        var file=Path.Combine(directory,"protected-test.key");
        BreezeSpeech.SaveKey(file,"fake-unit-test-credential");
        Assert(BreezeSpeech.LoadKey(file)=="fake-unit-test-credential");
        Assert(!Encoding.UTF8.GetString(File.ReadAllBytes(file)).Contains("fake-unit-test-credential"));
        BreezeSpeech.SaveKey(file,"");Assert(BreezeSpeech.LoadKey(file)=="fake-unit-test-credential");
        Console.WriteLine("PASS "+count+" BreezeBlue contract and encrypted credential checks.");
    }
}
