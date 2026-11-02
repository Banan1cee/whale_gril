using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace WhaleLauncher;

public sealed record RecordingShortcut(ushort[] Keys, string Label)
{
    public static RecordingShortcut Parse(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException("请填写微信录音快捷键，例如 Ctrl+Alt");
        var tokens=value.Split('+').Select(s=>s.Trim()).ToArray();
        if(tokens.Length>4||tokens.Any(string.IsNullOrEmpty))throw new ArgumentException("快捷键格式无效");
        var modifiers=new HashSet<ushort>(); ushort? main=null; string mainLabel=null;
        foreach(var token in tokens)
        {
            string key=token.ToUpperInvariant();
            ushort modifier=key is "CTRL" or "CONTROL" ? (ushort)0x11 : key=="ALT"?(ushort)0x12:key=="SHIFT"?(ushort)0x10:(ushort)0;
            if(modifier!=0){if(!modifiers.Add(modifier))throw new ArgumentException("快捷键修饰键不能重复");continue;}
            if(main.HasValue)throw new ArgumentException("只能配置一个普通按键，其他按键须为 Ctrl、Alt、Shift");
            if(key.Length==1&&((key[0]>='A'&&key[0]<='Z')||(key[0]>='0'&&key[0]<='9'))){main=key[0];mainLabel=key;}
            else if(Regex.IsMatch(key,@"^F(?:[1-9]|1[0-9]|2[0-4])$")){main=(ushort)(0x70+int.Parse(key[1..])-1);mainLabel=key;}
            else if(key is "=" or "OEMPLUS"){main=0xBB;mainLabel="=";}
            else throw new ArgumentException("支持 Ctrl/Alt/Shift、字母、数字、F1～F24 和 = 号");
        }
        if(modifiers.Count==0&&!main.HasValue)throw new ArgumentException("快捷键不能为空");
        var result=new List<ushort>();var labels=new List<string>();
        foreach(var pair in new[]{(Code:(ushort)0x11,Name:"Ctrl"),(Code:(ushort)0x12,Name:"Alt"),(Code:(ushort)0x10,Name:"Shift")})
            if(modifiers.Contains(pair.Code)){result.Add(pair.Code);labels.Add(pair.Name);}
        if(main.HasValue){result.Add(main.Value);labels.Add(mainLabel);}
        return new RecordingShortcut(result.ToArray(),string.Join("+",labels));
    }

    public bool MatchesButton(string text)
    {
        if(!text.Contains("发语音"))return false;
        var match=Regex.Match(text,@"按住\s*([^()（）]+)");
        if(!match.Success)return false;
        try{return Parse(match.Groups[1].Value).Keys.SequenceEqual(Keys);}catch(ArgumentException){return false;}
    }
}
