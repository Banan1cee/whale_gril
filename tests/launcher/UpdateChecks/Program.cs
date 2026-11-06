using System;
using System.Reflection;
using WhaleLauncher;

void Check(bool ok, string message) { if (!ok) throw new Exception(message); Console.WriteLine("PASS: " + message); }
var parse = typeof(UpdateManifestService).GetMethod("Parse", BindingFlags.Static | BindingFlags.NonPublic);
var manifest = (UpdateManifest)parse.Invoke(null, new object[] { "{\"latest\":\"4.0.6\",\"message\":\"新版发布\",\"release_notes\":\"### 修复\\n- 修复编码切换。\\n  - 内部实现细节\\n- 支持私聊记忆清理。\"}" });
var summary = UpdateManifestService.ReleaseSummary(manifest);
Check(summary.Contains("修复编码切换") && summary.Contains("私聊记忆清理"), "新版摘要直接包含更新与修复内容");
Check(!summary.Contains("内部实现细节") && !summary.Contains("###"), "摘要省略展开细节和 Markdown 标记");
Check(UpdateManifestService.ReleaseSummary(new UpdateManifest { Message = "旧清单说明" }) == "旧清单说明", "旧清单没有 release_notes 时兼容 message");
Check(UpdateManifestService.ReleaseSummary(null).Contains("暂未提供"), "缺少说明时明确提示，不能编造修复内容");
Check(UpdateManifestService.ReleaseSummary(new UpdateManifest { ReleaseNotes = new string('测', 3000) }).Length <= 1401, "过长的更新说明有长度上限");
