using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using WhaleLauncher;

static class LatencyChecks
{
    sealed class Handler(Func<CancellationToken,Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)=>send(ct);
    }
    sealed class SlowBody : MemoryStream
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken ct=default)
        { await Task.Delay(Timeout.Infinite,ct);return 0; }
    }
    public static async Task Run(string directory)
    {
        int checks=0;void Check(bool ok){if(!ok)throw new Exception("Voice latency check failed");checks++;}
        Check(new AutoVoiceSettings().SynthTimeoutSec==20);
        foreach(bool body in new[]{false,true})
        {
            using var client=new HttpClient(new Handler(async ct=>{
                if(!body)await Task.Delay(Timeout.Infinite,ct);
                return new HttpResponseMessage(HttpStatusCode.OK){Content=new StreamContent(new SlowBody())};
            }));
            var metrics=new BreezeSpeech.RequestMetrics();bool timedOut=false;
            try{await BreezeSpeech.Generate("fake-test-key","model","voc_test","测试","",Path.Combine(directory,"slow-"+body+".wav"),CancellationToken.None,metrics,TimeSpan.FromMilliseconds(40),client);}
            catch(TimeoutException){timedOut=true;}
            Check(timedOut&&metrics.RequestMs>0);
            Check(body?metrics.HttpStatus==200:metrics.HttpStatus==null);
        }
        using(var client=new HttpClient(new Handler(ct=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)))))
        {
            var metrics=new BreezeSpeech.RequestMetrics();bool rejected=false;
            try{await BreezeSpeech.Generate("fake-test-key","model","voc_test","测试","",Path.Combine(directory,"failed.wav"),CancellationToken.None,metrics,null,client);}
            catch(HttpRequestException ex){rejected=ex.StatusCode==HttpStatusCode.ServiceUnavailable;}
            Check(rejected&&metrics.HttpStatus==503&&metrics.HeadersMs.HasValue);
        }
        using(var client=new HttpClient(new Handler(async ct=>{await Task.Delay(Timeout.Infinite,ct);return null;})))
        using(var stop=new CancellationTokenSource(40))
        {
            bool cancelled=false;
            try{await BreezeSpeech.Generate("fake-test-key","model","voc_test","测试","",Path.Combine(directory,"cancelled.wav"),stop.Token,null,null,client);}
            catch(OperationCanceledException){cancelled=true;}
            Check(cancelled);
        }
        Console.WriteLine("PASS "+checks+" synthesis deadline, stalled body, HTTP diagnostics and cancellation checks; no live API.");
    }
}
