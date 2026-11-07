using System;
using System.Buffers.Binary;
using System.IO;
using System.Text;

namespace WhaleLauncher;

public static class DownloadedWave
{
    // 仅在 HTTP 响应完整读完后调用：部分合成接口保留了流式 WAV 的未知长度标记。
    // 普通声明长度不符仍视为截断，不能通过缩短文件头把损坏音频伪装成有效音频。
    public static void FinalizeHeader(byte[] audio)
    {
        bool Tag(int at,string value)=>at>=0&&at+4<=audio.Length&&Encoding.ASCII.GetString(audio,at,4)==value;
        uint Size(int at)=>BinaryPrimitives.ReadUInt32LittleEndian(audio.AsSpan(at,4));
        if(audio.Length<44||!Tag(0,"RIFF")||!Tag(8,"WAVE"))throw new InvalidDataException("语音接口未返回有效 WAV 音频");
        uint riff=Size(4);bool unknownRiff=riff>=0xFFFF0000;
        if(!unknownRiff&&riff+8L>audio.Length)throw new InvalidDataException("WAV 音频下载不完整，请重试");
        int blockAlign=0;
        for(int at=12;at+8<=audio.Length;) {
            uint length=Size(at+4);int start=at+8;long end=start+(long)length;
            if(Tag(at,"data")) {
                if(blockAlign<=0)throw new InvalidDataException("WAV 缺少有效采样格式");
                if(unknownRiff&&length>=0xFFFF0000) {
                    int actual=audio.Length-start;
                    if(actual%blockAlign!=0)throw new InvalidDataException("WAV 音频采样不完整");
                    BinaryPrimitives.WriteUInt32LittleEndian(audio.AsSpan(4,4),(uint)(audio.Length-8));
                    BinaryPrimitives.WriteUInt32LittleEndian(audio.AsSpan(at+4,4),(uint)actual);
                    return;
                }
                if(unknownRiff||end>audio.Length||length%blockAlign!=0)throw new InvalidDataException("WAV 音频长度异常或下载不完整");
                return;
            }
            if(end>audio.Length)throw new InvalidDataException("WAV 音频头不完整");
            if(Tag(at,"fmt ")) {
                if(length<16)throw new InvalidDataException("WAV 采样格式不完整");
                ushort format=BinaryPrimitives.ReadUInt16LittleEndian(audio.AsSpan(start,2));
                int channels=BinaryPrimitives.ReadUInt16LittleEndian(audio.AsSpan(start+2,2));
                uint rate=Size(start+4),byteRate=Size(start+8);
                blockAlign=BinaryPrimitives.ReadUInt16LittleEndian(audio.AsSpan(start+12,2));
                int bits=BinaryPrimitives.ReadUInt16LittleEndian(audio.AsSpan(start+14,2));
                if((format!=1&&format!=3)||channels<1||channels>8||rate<8000||rate>192000||bits<8||bits>32||bits%8!=0
                    ||blockAlign!=channels*bits/8||byteRate!=rate*blockAlign)
                    throw new InvalidDataException("WAV 采样格式异常或不支持");
            }
            long next=end+(length%2);
            if(next>audio.Length)break;
            at=(int)next;
        }
        throw new InvalidDataException("WAV 没有音频数据");
    }
}
