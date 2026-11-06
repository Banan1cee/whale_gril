using System;
using System.IO;
using System.Linq;
using WhaleLauncher;

static class VbCableChecks
{
    public static void Run(string root)
    {
        var directory=Path.Combine(root,"incomplete-driver");Directory.CreateDirectory(directory);
        var missing=VbCablePackage.Problems(directory);
        if(missing.Length!=31||missing.Count(n=>n.EndsWith(".cat"))!=8)throw new Exception("Incomplete driver package was accepted");
        if(!missing.Contains("缺少 vbaudio_cable64_win10.cat"))throw new Exception("Missing Win10 CAT diagnostic");
        File.WriteAllText(Path.Combine(directory,"vbaudio_cable64_win10.cat"),"corrupt catalog");
        if(!VbCablePackage.Problems(directory).Contains("文件损坏或版本不符 vbaudio_cable64_win10.cat"))throw new Exception("Corrupt CAT accepted");
        bool rejected=false;try{VbCablePackage.Validate(directory);}catch(InvalidOperationException ex){rejected=ex.Message.Contains("vbaudio_cable64_win10.cat");}
        if(!rejected)throw new Exception("Incomplete driver install not blocked");
        Console.WriteLine("PASS driver preflight rejects missing/corrupt catalogs before launching any installer.");
    }
}
