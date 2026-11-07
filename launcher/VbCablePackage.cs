using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;

namespace WhaleLauncher;

public static class VbCablePackage
{
    public static string[] Problems(string directory)
    {
        using var resource = typeof(VbCablePackage).Assembly.GetManifestResourceStream("WhaleLauncher.VbCablePack45.json");
        var expected = JsonSerializer.Deserialize<Dictionary<string,string>>(resource);
        var problems = new List<string>();
        foreach (var entry in expected) {
            var file = Path.Combine(directory, entry.Key);
            if (!File.Exists(file)) { problems.Add("缺少 " + entry.Key); continue; }
            using var input = File.OpenRead(file);
            if (!Convert.ToHexString(SHA256.HashData(input)).Equals(entry.Value, StringComparison.OrdinalIgnoreCase))
                problems.Add("文件损坏或版本不符 " + entry.Key);
        }
        return problems.ToArray();
    }
    public static void Validate(string directory)
    {
        var problems = Problems(directory);
        if (problems.Length > 0) throw new InvalidOperationException("VB-CABLE 驱动包不完整：" + string.Join("；", problems)
            + "。请从 https://vb-audio.com/Cable/ 获取 Pack45，完整解压到同一目录后再安装。");
    }
}
