using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using WhaleLauncher;

static class VoiceTestChecks
{
    sealed class FakeHttp(Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> action) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)=>action(request,ct);
    }
    public static async Task Run(string directory)
    {
        int count=0;void Check(bool value){if(!value)throw new Exception("Voice test button check failed");count++;}
        using(var http=new HttpClient(new FakeHttp((q,ct)=>{
            Check(q.Method==HttpMethod.Get&&q.RequestUri.AbsoluteUri==BreezeSpeech.BaseUrl+"/models");
            Check(q.Headers.GetValues("xi-api-key").Single()=="test-only-key");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("[]")});
        }))) Check((await BreezeSpeech.CheckKey("test-only-key",CancellationToken.None,http)).Available);
        foreach(var code in new[]{HttpStatusCode.Unauthorized,HttpStatusCode.Forbidden,HttpStatusCode.TooManyRequests,HttpStatusCode.InternalServerError})
        {
            using var http=new HttpClient(new FakeHttp((q,ct)=>Task.FromResult(new HttpResponseMessage(code))));
            var result=await BreezeSpeech.CheckKey("test-only-key",CancellationToken.None,http);
            Check(!result.Available&&result.Message.Contains("API Key 不可用"));
        }
        using(var http=new HttpClient(new FakeHttp(async(q,ct)=>{await Task.Delay(Timeout.Infinite,ct);return null;})))
        {
            var result=await BreezeSpeech.CheckKey("test-only-key",CancellationToken.None,http,TimeSpan.FromMilliseconds(30));
            Check(!result.Available&&result.Message.Contains("超时"));
            using var stop=new CancellationTokenSource();stop.Cancel();bool cancelled=false;
            try{await BreezeSpeech.CheckKey("test-only-key",stop.Token,http);}catch(OperationCanceledException){cancelled=true;}
            Check(cancelled);
        }
        using(var http=new HttpClient(new FakeHttp((q,ct)=>throw new HttpRequestException("test"))))
            Check(!(await BreezeSpeech.CheckKey("test-only-key",CancellationToken.None,http)).Available);
        using(var http=new HttpClient(new FakeHttp((q,ct)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("<html>invalid</html>")}))))
            Check(!(await BreezeSpeech.CheckKey("test-only-key",CancellationToken.None,http)).Available);
        Check(!(await BreezeSpeech.CheckKey("",CancellationToken.None)).Available);
        var root=Path.Combine(directory,"test-buttons");Directory.CreateDirectory(Path.Combine(root,"data"));
        bool rejected=false;try{await VoiceSendTest.Run(root,CancellationToken.None);}catch(Exception){rejected=true;}
        Check(rejected&&!Directory.Exists(Path.Combine(root,"data","voice-send-tests")));
        File.WriteAllText(Path.Combine(root,"data","voice-send.json"),"{\"Enabled\":true}");
        Check(VoiceSendTest.Text=="哈喽哈喽，可以听见我说话么");
        var job=VoiceSendTest.Run(root,CancellationToken.None);
        var folder=Path.Combine(root,"data","voice-send-tests");var request=Directory.GetFiles(folder,"*.json").Single();
        using(var json=JsonDocument.Parse(File.ReadAllText(request))) Check(json.RootElement.GetProperty("CreatedAt").GetInt64()>0);
        string path=Path.Combine(folder,Path.GetFileNameWithoutExtension(request));File.Move(request,path+".claimed");
        File.WriteAllText(path+".result","{\"Status\":\"uncertain\",\"Error\":\"\"}");
        Check((await job).Contains("结果未确认"));Check(!Directory.GetFiles(folder).Any());
        using(var stop=new CancellationTokenSource())
        {
            job=VoiceSendTest.Run(root,stop.Token);request=Directory.GetFiles(folder,"*.json").Single();
            path=Path.Combine(folder,Path.GetFileNameWithoutExtension(request));File.Move(request,path+".claimed");
            stop.Cancel();bool cancelled=false;try{await job;}catch(OperationCanceledException){cancelled=true;}
            Check(cancelled&&File.Exists(path+".cancel"));Check(!File.Exists(path+".json"));
        }
        Console.WriteLine("PASS "+count+" API connection, timeout and one-shot test queue checks; no live API or WeChat messages.");
    }
}
