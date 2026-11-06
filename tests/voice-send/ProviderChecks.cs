using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Controls;
using NAudio.Wave;
using WhaleLauncher;
using WhaleLauncher.Views;

static class ProviderChecks
{
    sealed class Handler(Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> send) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)=>send(request,ct); }
    sealed class StalledBody : MemoryStream
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken ct=default)
        { await Task.Delay(Timeout.Infinite,ct); return 0; }
    }
    static HttpResponseMessage Json(string body)=>new(HttpStatusCode.OK){Content=new StringContent(body)};
    static byte[] Audio()
    {
        using var output=new MemoryStream();
        using(var wave=new WaveFileWriter(new NAudio.Utils.IgnoreDisposeStream(output),new WaveFormat(32000,16,1)))wave.Write(new byte[128000]);
        return output.ToArray();
    }
    public static async Task Run(string directory)
    {
        int count=0;void Check(bool ok){if(!ok)throw new Exception("Speech provider check failed #"+(count+1));count++;}
        Check(SpeechProviders.All.Length==3);
        bool rejected=false;try{SpeechProviders.KeyFile(directory,"../other");}catch(ArgumentException){rejected=true;}Check(rejected);
        var oldKey=SpeechProviders.KeyFile(directory,"breezeblue");
        BreezeSpeech.SaveKey(oldKey,"fake-breeze-key");BreezeSpeech.SaveKey(SpeechProviders.KeyFile(directory,"minimax"),"fake-minimax-key");
        Check(BreezeSpeech.LoadKey(oldKey)=="fake-breeze-key");
        Check(BreezeSpeech.LoadKey(SpeechProviders.KeyFile(directory,"minimax"))=="fake-minimax-key");
        Check(BreezeSpeech.LoadKey(SpeechProviders.KeyFile(directory,"siliconflow"))=="");
        var wave=Audio();
        foreach(string id in new[]{"breezeblue","minimax","siliconflow"})
        {
            var defaults=SpeechProviders.Defaults(id);int calls=0;
            using var client=new HttpClient(new Handler(async(q,ct)=>{
                calls++;Check(q.RequestUri.Host==new Uri(SpeechProviders.Get(id).BaseUrl).Host);
                using var body=JsonDocument.Parse(await q.Content.ReadAsStringAsync(ct));var b=body.RootElement;
                if(id=="breezeblue") {
                    Check(q.Headers.GetValues("xi-api-key").Single()=="fake-key");Check(b.GetProperty("text").GetString()=="测试正文");
                } else {
                    Check(q.Headers.Authorization?.ToString()=="Bearer fake-key");
                    Check(!q.Headers.Contains("xi-api-key"));Check(b.GetProperty("stream").GetBoolean()==false);
                    if(id=="minimax") {
                        Check(q.RequestUri.AbsolutePath=="/v1/t2a_v2");Check(b.GetProperty("text").GetString()=="测试正文");
                        Check(b.GetProperty("voice_setting").GetProperty("voice_id").GetString()==defaults.Voice);
                        Check(b.GetProperty("audio_setting").GetProperty("format").GetString()=="wav");
                        Check(b.GetProperty("output_format").GetString()=="hex");
                        return Json(JsonSerializer.Serialize(new{base_resp=new{status_code=0},data=new{audio=Convert.ToHexString(wave),status=2}}));
                    }
                    Check(q.RequestUri.AbsolutePath=="/v1/audio/speech");Check(b.GetProperty("response_format").GetString()=="wav");
                    Check(b.GetProperty("voice").GetString()==defaults.Voice);Check(b.GetProperty("input").GetString()=="轻松地说<|endofprompt|>测试正文");
                }
                return new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(wave)};
            }));
            string file=Path.Combine(directory,id+"-generated.wav");var metrics=new BreezeSpeech.RequestMetrics();
            await SpeechProviders.Generate(id,"fake-key",defaults.Model,defaults.Voice,"测试正文","轻松地说",file,CancellationToken.None,metrics,null,client);
            Check(calls==1&&metrics.HttpStatus==200&&metrics.HeadersMs.HasValue);Check(VoiceSendEngine.ValidateWave(file)==2);
        }
        foreach(string id in new[]{"minimax","siliconflow"})
        {
            int calls=0;
            using(var client=new HttpClient(new Handler((q,ct)=>{
                calls++;Check(q.Headers.Authorization?.Parameter=="fake-key");
                Check(q.RequestUri.AbsolutePath==(id=="minimax"?"/v1/get_voice":"/v1/models"));
                Check(q.Method==(id=="minimax"?HttpMethod.Post:HttpMethod.Get));
                return Task.FromResult(Json(id=="minimax"?"{\"base_resp\":{\"status_code\":0},\"system_voice\":[]}":"{\"data\":[]}"));
            })))Check((await SpeechProviders.CheckKey(id,"fake-key",CancellationToken.None,client)).Available&&calls==1);
            Check(!(await SpeechProviders.CheckKey(id,"",CancellationToken.None)).Available);
            using(var client=new HttpClient(new Handler((q,ct)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized)))))
                Check(!(await SpeechProviders.CheckKey(id,"fake-key",CancellationToken.None,client)).Available);
            foreach(bool body in new[]{false,true}) {
                using var client=new HttpClient(new Handler(async(q,ct)=>{
                    if(!body)await Task.Delay(Timeout.Infinite,ct);
                    return new HttpResponseMessage(HttpStatusCode.OK){Content=new StreamContent(new StalledBody())};
                }));
                string file=Path.Combine(directory,id+"-timeout-"+body+".wav");bool timedOut=false;
                try{await SpeechProviders.Generate(id,"fake-key","model","voice","测试","",file,CancellationToken.None,null,TimeSpan.FromMilliseconds(40),client);}
                catch(TimeoutException){timedOut=true;}Check(timedOut&&!File.Exists(file));
            }
            using(var stop=new CancellationTokenSource(40))
            using(var client=new HttpClient(new Handler(async(q,ct)=>{await Task.Delay(Timeout.Infinite,ct);return null;}))) {
                bool cancelled=false;
                try{await SpeechProviders.Generate(id,"fake-key","model","voice","测试","",Path.Combine(directory,"cancel-"+id),stop.Token,null,null,client);}
                catch(OperationCanceledException){cancelled=true;}Check(cancelled);
            }
            foreach(string failure in new[]{"http","accepted","invalid","oversize","business"}) {
                calls=0;var file=Path.Combine(directory,id+"-"+failure+".wav");
                using var client=new HttpClient(new Handler((q,ct)=>{
                    calls++;var result=failure switch {
                        "http"=>new HttpResponseMessage(HttpStatusCode.ServiceUnavailable),
                        "accepted"=>new HttpResponseMessage(HttpStatusCode.Accepted),
                        "business"=>Json("{\"base_resp\":{\"status_code\":1008},\"data\":null}"),
                        _=>Json("not audio")};
                    if(failure=="oversize")result.Content.Headers.ContentLength=40*1024*1024;
                    return Task.FromResult(result);
                }));
                bool failed=false;try{await SpeechProviders.Generate(id,"fake-key","model","voice","测试","",file,CancellationToken.None,null,null,client);}catch{failed=true;}
                Check(failed&&calls==1&&!File.Exists(file));
            }
        }
        using(var client=new HttpClient(new Handler((q,ct)=>Task.FromResult(Json("{\"base_resp\":{\"status_code\":0},\"system_voice\":[{\"voice_id\":\"Chinese (Mandarin)_Warm_Bestie\",\"voice_name\":\"温暖闺蜜\"}],\"voice_cloning\":[{\"voice_id\":\"custom-voice\"}]}"))))) {
            var voices=await SpeechProviders.Catalog("minimax","fake-key",true,"custom",CancellationToken.None,client);
            Check(voices.Single().Id=="custom-voice");
        }
        using(var client=new HttpClient(new Handler((q,ct)=>Task.FromResult(Json("{\"results\":[{\"model\":\"FunAudioLLM/CosyVoice2-0.5B\",\"uri\":\"speech:custom:123\",\"customName\":\"自定义\"},{\"model\":\"other\",\"uri\":\"other:voice\",\"customName\":\"其他\"}]}"))))) {
            var voices=await SpeechProviders.Catalog("siliconflow","fake-key",true,"",CancellationToken.None,client);
            Check(voices.Single().Id=="speech:custom:123");
        }
        Check(SpeechProviders.Choices("minimax",null,"my-custom-model",false).Any(c=>c.Id=="my-custom-model"));
        Check(SpeechProviders.Choices("minimax",null,"",false).Length==8);
        Check(SpeechProviders.Choices("minimax",null,"",true).Length==327);
        Check(SpeechProviders.Choices("minimax",null,"",true).Any(c=>c.Id=="female-tianmei"));
        Check(SpeechProviders.Choices("siliconflow",null,"",false).Any(c=>c.Id==SpeechProviders.MossModel));
        Check(SpeechProviders.Choices("siliconflow",null,"",true).Length==8);
        Check(SpeechProviders.Choices("siliconflow",null,"",true,SpeechProviders.MossModel).All(c=>c.Id.StartsWith(SpeechProviders.MossModel+":")));
        using(var request=SpeechProviders.CreateRequest("siliconflow","fake-key",SpeechProviders.MossModel,SpeechProviders.MossModel+":claire","测试正文","不会当正文读出的语气指令"))
        using(var json=JsonDocument.Parse(await request.Content.ReadAsStringAsync()))
            Check(json.RootElement.GetProperty("input").GetString()=="[S1]测试正文");
        using(var client=new HttpClient(new Handler((q,ct)=>Task.FromResult(Json("{\"data\":[{\"id\":\"FunAudioLLM/CosyVoice2-0.5B\"},{\"id\":\"fnlp/MOSS-TTSD-v0.5\"},{\"id\":\"future/speech\",\"sub_type\":\"text-to-speech\"},{\"id\":\"FunAudioLLM/SenseVoiceSmall\"}]}"))))) {
            var models=await SpeechProviders.Catalog("siliconflow","fake-key",false,"",CancellationToken.None,client);
            Check(models.Length==3&&models.Any(c=>c.Id==SpeechProviders.MossModel)&&!models.Any(c=>c.Id.Contains("SenseVoice")));
        }
        using(var client=new HttpClient(new Handler((q,ct)=>Task.FromResult(Json("{\"results\":[{\"model\":\"FunAudioLLM/CosyVoice2-0.5B\",\"uri\":\"speech:cosy\",\"customName\":\"Cosy\"},{\"model\":\"fnlp/MOSS-TTSD-v0.5\",\"uri\":\"speech:moss\",\"customName\":\"Moss\"}]}"))))) {
            var voices=await SpeechProviders.Catalog("siliconflow","fake-key",true,"",CancellationToken.None,client,SpeechProviders.MossModel);
            Check(voices.Single().Id=="speech:moss");
        }
        UiChecks(directory,Check);
        Console.WriteLine("PASS "+count+" provider dispatch, WAV/hex, deadline, no-retry, catalog, credential isolation and UI save/reload checks; no live APIs or WeChat messages.");
    }
    static void UiChecks(string directory,Action<bool> check)
    {
        Exception error=null;
        var thread=new Thread(()=>{
            try {
                string root=Path.Combine(directory,"providers-ui");Directory.CreateDirectory(Path.Combine(root,"data"));
                File.WriteAllText(Path.Combine(root,"data","voice-send.json"),JsonSerializer.Serialize(new AutoVoiceSettings{Model="breeze-custom",Voice="voc_saved"}));
                using var sup=new RuntimeSupervisor(root);var page=new VoiceSendPage(sup);
                T Field<T>(string name)=>(T)typeof(VoiceSendPage).GetField(name,BindingFlags.Instance|BindingFlags.NonPublic).GetValue(page);
                var pick=Field<ComboBox>("provider");var key=Field<PasswordBox>("key");var model=Field<TextBox>("model");var voice=Field<TextBox>("voice");
                check(((SpeechProviders.Provider)pick.SelectedItem).Id=="breezeblue"&&voice.Text=="voc_saved");
                key.Password="fake-breeze-key";
                pick.SelectedItem=SpeechProviders.Get("minimax");check(key.Password==""&&model.Text=="speech-2.8-turbo");
                model.Text="speech-2.6-hd";key.Password="fake-minimax-key";
                pick.SelectedItem=SpeechProviders.Get("siliconflow");check(key.Password==""&&voice.Text==SpeechProviders.CosyModel+":claire");
                var choices=Field<ComboBox>("models");var voiceChoices=Field<ComboBox>("voices");
                voice.Text="speech:custom-cosy";
                choices.SelectedItem=choices.Items.Cast<BreezeSpeech.Choice>().Single(c=>c.Id==SpeechProviders.MossModel);
                check(model.Text==SpeechProviders.MossModel&&voice.Text==SpeechProviders.MossModel+":claire");
                check(!Field<TextBox>("instructions").IsEnabled);
                voice.Text="speech:custom-moss";
                choices.SelectedItem=choices.Items.Cast<BreezeSpeech.Choice>().Single(c=>c.Id==SpeechProviders.CosyModel);
                check(voice.Text=="speech:custom-cosy"&&Field<TextBox>("instructions").IsEnabled);
                choices.SelectedItem=choices.Items.Cast<BreezeSpeech.Choice>().Single(c=>c.Id==SpeechProviders.MossModel);
                check(voice.Text=="speech:custom-moss");
                pick.SelectedItem=SpeechProviders.Get("minimax");
                Field<TextBox>("search").Text="甜美";
                check(voiceChoices.Items.Cast<BreezeSpeech.Choice>().Any(c=>c.Id=="female-tianmei"));
                check(voiceChoices.Items.Count<327);
                pick.SelectedItem=SpeechProviders.Get("siliconflow");
                check(Field<TextBox>("search").Text==""&&voiceChoices.Items.Count==9&&voice.Text=="speech:custom-moss");
                var guide=VoiceSendGuide.Create(()=>{});
                var captions=GuideButtons(guide).Select(b=>b.Content?.ToString()??"").ToArray();
                check(captions.Any(s=>s.Contains("MiniMax 官网"))&&captions.Any(s=>s.Contains("硅基流动官网")));
                check(captions.Any(s=>s.Contains("MiniMax · 创建"))&&captions.Any(s=>s.Contains("硅基流动 · 创建")));
                pick.SelectedItem=SpeechProviders.Get("minimax");check(key.Password=="fake-minimax-key"&&model.Text=="speech-2.6-hd");
                pick.SelectedItem=SpeechProviders.Get("breezeblue");check(key.Password=="fake-breeze-key"&&voice.Text=="voc_saved"&&model.Text=="breeze-custom");
                pick.SelectedItem=SpeechProviders.Get("minimax");Field<CheckBox>("experimental").IsChecked=true;
                var deviceType=typeof(VoiceSendPage).GetNestedType("Device",BindingFlags.NonPublic);
                var device=Activator.CreateInstance(deviceType,new object[]{"fake-render-device","Test device"});
                var devices=Field<ComboBox>("devices");devices.ItemsSource=new[]{device};devices.SelectedItem=device;
                typeof(VoiceSendPage).GetMethod("Save",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(page,null);
                var saved=AutoVoiceSettings.Load(root);check(saved.Provider=="minimax"&&saved.Model=="speech-2.6-hd");
                check(saved.Profiles["breezeblue"].Voice=="voc_saved");
                check(BreezeSpeech.LoadKey(SpeechProviders.KeyFile(root,"minimax"))=="fake-minimax-key");
                check(!File.Exists(SpeechProviders.KeyFile(root,"breezeblue")));
                check(!File.ReadAllText(Path.Combine(root,"data","voice-send.json")).Contains("fake-minimax-key"));
                typeof(VoiceSendPage).GetMethod("Load",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(page,null);
                check(((SpeechProviders.Provider)pick.SelectedItem).Id=="minimax"&&key.Password=="");
                pick.SelectedItem=SpeechProviders.Get("breezeblue");check(voice.Text=="voc_saved"&&model.Text=="breeze-custom"&&key.Password=="");
                Field<CheckBox>("experimental").IsChecked=false;
            }catch(Exception ex){error=ex;}
        });
        thread.SetApartmentState(ApartmentState.STA);thread.Start();thread.Join();if(error!=null)throw error;
    }
    static System.Collections.Generic.IEnumerable<Button> GuideButtons(System.Windows.DependencyObject root)
    {
        foreach(var item in System.Windows.LogicalTreeHelper.GetChildren(root)) {
            if(item is Button button)yield return button;
            if(item is System.Windows.DependencyObject child)foreach(var nested in GuideButtons(child))yield return nested;
        }
    }
}
