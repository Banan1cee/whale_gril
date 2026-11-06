using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using WhaleLauncher;

static class StreamingWaveChecks
{
    sealed class Handler(byte[] bytes):HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage q,CancellationToken ct)
            =>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(bytes)});
    }
    static byte[] Wave(int dataSize,uint? riffSize=null,uint? declaredData=null)
    {
        using var memory=new MemoryStream();using var w=new BinaryWriter(memory);
        w.Write(Encoding.ASCII.GetBytes("RIFF"));w.Write(riffSize??(uint)(166+dataSize));w.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
        w.Write(16);w.Write((ushort)1);w.Write((ushort)1);w.Write(32000);w.Write(64000);w.Write((ushort)2);w.Write((ushort)16);
        w.Write(Encoding.ASCII.GetBytes("LIST"));w.Write(122);w.Write(new byte[122]);
        w.Write(Encoding.ASCII.GetBytes("data"));w.Write(declaredData??(uint)dataSize);
        w.Write(Enumerable.Range(0,dataSize).Select(n=>(byte)(n%127)).ToArray());
        return memory.ToArray();
    }
    public static async Task Run(string root)
    {
        int count=0;void Check(bool ok){if(!ok)throw new Exception("Streaming WAV regression failed #"+(count+1));count++;}
        var bytes=Wave(171350,0xFFFFFFA6,0xFFFFFF00);
        var original=(byte[])bytes.Clone();var file=Path.Combine(root,"silicon-stream.wav");
        using(var client=new HttpClient(new Handler(bytes)))
            await SpeechProviders.Generate("siliconflow","fake-key",SpeechProviders.CosyModel,SpeechProviders.CosyModel+":claire","测试","",file,CancellationToken.None,null,null,client);
        Check(Math.Abs(VoiceSendEngine.ValidateWave(file)-2.67734375)<.00001);
        var fixedBytes=File.ReadAllBytes(file);
        Check(fixedBytes.AsSpan(174).SequenceEqual(original.AsSpan(174)));
        Check(BitConverter.ToUInt32(fixedBytes,4)==fixedBytes.Length-8&&BitConverter.ToUInt32(fixedBytes,170)==171350);
        foreach(var audio in new[]{Wave(128000),Wave(56*64000,uint.MaxValue,uint.MaxValue),Wave(32000,uint.MaxValue,uint.MaxValue),Wave(128000,166+128000,128100),new byte[20]}) {
            file=Path.Combine(root,Guid.NewGuid()+".wav");bool success=false;
            using var client=new HttpClient(new Handler(audio));
            try {await SpeechProviders.Generate("siliconflow","fake-key",SpeechProviders.CosyModel,SpeechProviders.CosyModel+":claire","测试","",file,CancellationToken.None,null,null,client);success=true;}
            catch(ArgumentException){}catch(InvalidDataException){}
            Check(success==(audio.Length==128174&&BitConverter.ToUInt32(audio,170)==128000));
            if(!success)Check(!File.Exists(file));
        }
        Check(SpeechProviders.Defaults("minimax").Voice=="qiaopi_mengmei");
        Check(SpeechProviders.Choices("minimax",null,"",true).First().Name.Contains("普通话"));
        Console.WriteLine("PASS "+count+" streaming WAV duration, unchanged samples, genuine long/short/truncated audio and MiniMax default checks.");
    }
}
