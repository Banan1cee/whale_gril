using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NAudio.Wave;
using WhaleLauncher;
class Program {
 static int count;static void Assert(bool v){if(!v)throw new Exception("assert failed");count++;}static void Reject(Action f){try{f();}catch{count++;return;}throw new Exception("expected rejection");}
 static byte[] Wav(double s){using var m=new MemoryStream();using(var w=new WaveFileWriter(new NAudio.Utils.IgnoreDisposeStream(m),new WaveFormat(16000,16,1))){var b=new byte[(int)(s*32000)];w.Write(b,0,b.Length);}return m.ToArray();}
 static async Task Main(){var dir=Path.Combine(Path.GetTempPath(),"voice-check-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);try{
 await BreezeChecks.Run(dir);
 await AutoVoiceChecks.Run(dir);
 ExperimentalVoiceChecks.Run(dir);
 await VoiceTestChecks.Run(dir);
 Assert(VoiceSendEngine.Endpoint("https://example.com/audio/speech").Scheme=="https");Assert(VoiceSendEngine.Endpoint("http://127.0.0.1/audio/speech").IsLoopback);
 Reject(()=>VoiceSendEngine.Endpoint("http://example.com/audio/speech"));Reject(()=>VoiceSendEngine.Endpoint("file:///private"));Reject(()=>VoiceSendEngine.Endpoint("https://key@example.com/audio/speech"));
 var f=Path.Combine(dir,"test.wav");File.WriteAllBytes(f,Wav(2));Assert(VoiceSendEngine.ValidateWave(f)==2);File.WriteAllBytes(f,Wav(.5));Reject(()=>VoiceSendEngine.ValidateWave(f));File.WriteAllBytes(f,Wav(56));Reject(()=>VoiceSendEngine.ValidateWave(f));File.WriteAllText(f,"bad");Reject(()=>VoiceSendEngine.ValidateWave(f));
 using var server=new TcpListener(IPAddress.Loopback,0);server.Start();var port=((IPEndPoint)server.LocalEndpoint).Port;
 var task=Task.Run(async()=>{using var c=await server.AcceptTcpClientAsync();using var s=c.GetStream();string header="";var one=new byte[1];while(!header.EndsWith("\r\n\r\n")){if(await s.ReadAsync(one)==0)throw new Exception("EOF");header+=(char)one[0];}Assert(header.Contains("Authorization: Bearer test-key"));int n=int.Parse(System.Text.RegularExpressions.Regex.Match(header,"Content-Length: (\\d+)",System.Text.RegularExpressions.RegexOptions.IgnoreCase).Groups[1].Value);var b=new byte[n];await s.ReadExactlyAsync(b);using var j=System.Text.Json.JsonDocument.Parse(b);Assert(j.RootElement.GetProperty("input").GetString()=="测试");Assert(j.RootElement.GetProperty("response_format").GetString()=="wav");var audio=Wav(2);await s.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Length: {audio.Length}\r\nConnection: close\r\n\r\n"));await s.WriteAsync(audio);});
 f=Path.Combine(dir,"generated.wav");await VoiceSendEngine.Generate($"http://127.0.0.1:{port}/speech","test-key","model","voice","测试",f,CancellationToken.None);await task;Assert(VoiceSendEngine.ValidateWave(f)==2);Console.WriteLine("PASS "+count+" checks; no real provider, audio output, keyboard injection or WeChat messages.");
 }finally{Directory.Delete(dir,true);}}
}
