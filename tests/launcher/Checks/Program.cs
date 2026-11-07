using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using WhaleLauncher;
var workspace = Path.GetFullPath(args[0]);
var root = Path.Combine(workspace, ".tools", "temp", "supervisor-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(Path.Combine(root, "runtime", "python"));
Directory.CreateDirectory(Path.Combine(root, "data"));
File.Copy(args[1],Path.Combine(root,"runtime","node.exe"));
foreach(var file in Directory.GetFiles(Path.Combine(workspace,"artifacts","launcher-tests","fake"))) File.Copy(file,Path.Combine(root,"runtime","python",Path.GetFileName(file)));
File.WriteAllText(Path.Combine(root,"server.js"), "const fs=require('fs'),http=require('http');const s=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify(q.url==='/healthz'?{ok:true,up:true,service:'whale-girl',pid:fs.existsSync('wrong-pid')?process.pid+1:process.pid}:{ok:true,gateways:[{platform:'douyin',bridge:{account_nick:'wrong'}},{platform:'wechat',bridge:{online:true,accountNick:'right'}}]}));});s.listen(0,'127.0.0.1',()=>fs.writeFileSync('data/server-port.txt',String(s.address().port)));process.stdin.on('data',b=>{if(String(b).includes('shutdown'))s.close(()=>process.exit(0));});");
void Check(bool ok,string message) { if(!ok) throw new Exception(message); Console.WriteLine("PASS: "+message); }
try {
 Check(Api.Detail(null)=="", "联系人摘要兼容空响应");
 Check(Api.Detail(new ApiResult { Raw=" \r\n ", Error="连接失败" })=="连接失败", "联系人摘要为空时保留原错误");
 Check(Api.Detail(new ApiResult { Raw="  first\r\nsecond  ", Error="fallback" })=="first  second", "联系人摘要去首尾空白并保持换行替换规则");
 Check(Api.Detail(new ApiResult { Raw=new string('中',120) })==new string('中',120), "联系人摘要 120 字不截断");
 Check(Api.Detail(new ApiResult { Raw=new string('中',121) })==new string('中',120)+"…", "联系人摘要超长才加省略号");
 using var sup = new RuntimeSupervisor(root);
 var restartHistory=(List<DateTime>)typeof(RuntimeSupervisor).GetField("_bridgeRestarts",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(sup);
 var previousRestart=DateTime.UtcNow.AddMinutes(-1);restartHistory.Add(previousRestart);
 await sup.StartAllAsync(clearRestartHistory:false);
 Check(sup.NodeRunning && restartHistory.Contains(previousRestart),"主窗口启动保留原有重启历史");
 Check(await sup.WaitForNodeAsync(),"内核就绪验证实例 PID");
 await sup.StartAllAsync();
 Check(!restartHistory.Contains(previousRestart),"诊断入口默认仍清空重启历史");
 for(int i=0;i<70;i++){if(File.Exists(Path.Combine(root,"bridge-test-count")) && File.ReadAllText(Path.Combine(root,"bridge-test-count"))=="2" && sup.BridgeRunning)break;await Task.Delay(100);}
 Check(File.ReadAllText(Path.Combine(root,"bridge-test-count"))=="2" && sup.BridgeRunning,"桥接 code 7 自动重启并保持运行");
 var state=await sup.ProbeAsync(); Check(state.NodeReady && state.BrAccountNick=="right","多平台状态选择微信而不是首项");
 sup.StopAll(); await Task.Delay(3300); Check(!sup.BridgeRunning && !sup.NodeRunning,"手动停止后不会被自动恢复拉起");
 File.WriteAllText(Path.Combine(root,"bridge-test-count"),"0");
 sup.StartNode();Check(await sup.WaitForNodeAsync(),"重新启动正常");sup.StartBridge();
 for(int i=0;i<30 && File.ReadAllText(Path.Combine(root,"bridge-test-count"))!="1";i++)await Task.Delay(100);
 await Task.Delay(200);sup.StopAll();await Task.Delay(3300);
 Check(File.ReadAllText(Path.Combine(root,"bridge-test-count"))=="1","停止会取消尚未执行的自动重启");
 var raw="中文\t\r\n\"\\\u0001";Check(JsonSerializer.Deserialize<string>("\""+Api.Esc(raw)+"\"")==raw,"JSON 转义保留控制字符");
 sup.StopAll(); File.WriteAllText(Path.Combine(root,"wrong-pid"),"1");
  var wrong= sup.StartAllAsync(clearRestartHistory:false);var wrongReady=sup.WaitForNodeAsync();await Task.Delay(400);sup.StopAll();
  Check(!await wrongReady,"不能把其它实例的健康响应误认为自身就绪");
  await wrong;Check(!sup.BridgeRunning,"内核 PID 不匹配时公共启动流程不能启动桥接");File.Delete(Path.Combine(root,"wrong-pid"));
 foreach(var code in new[]{0,1,2})
 {
  File.WriteAllText(Path.Combine(root,"bridge-test-count"),"0");File.WriteAllText(Path.Combine(root,"bridge-test-code"),code.ToString());
  sup.StartNode();Check(await sup.WaitForNodeAsync(),"故障场景内核就绪 "+code);sup.StartBridge();
  await Task.Delay(3600);
  Check(File.ReadAllText(Path.Combine(root,"bridge-test-count"))=="1" && !sup.BridgeRunning,"正常退出或配置错误不反复重启 code="+code);
  sup.StopAll();
 }
 File.WriteAllText(Path.Combine(root,"bridge-test-count"),"0");File.WriteAllText(Path.Combine(root,"bridge-test-code"),"7");File.WriteAllText(Path.Combine(root,"bridge-test-always"),"1");
 sup.StartNode();Check(await sup.WaitForNodeAsync(),"连续故障场景内核就绪");sup.StartBridge();await Task.Delay(14000);
 Check(File.ReadAllText(Path.Combine(root,"bridge-test-count"))=="4" && !sup.BridgeRunning,"连续异常最多自动恢复三次，避免重启风暴");
} finally {
 var allowed=Path.GetFullPath(Path.Combine(workspace,".tools","temp"))+Path.DirectorySeparatorChar;
 if(!Path.GetFullPath(root).StartsWith(allowed,StringComparison.OrdinalIgnoreCase))throw new Exception("invalid cleanup target");
 Directory.Delete(root,true);
}
