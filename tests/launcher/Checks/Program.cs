using System;
using System.IO;
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
 using var sup = new RuntimeSupervisor(root);
 sup.StartNode(); Check(await sup.WaitForNodeAsync(),"内核就绪验证实例 PID");
 sup.StartBridge();
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
 sup.StartNode(); var wrong= sup.WaitForNodeAsync(); await Task.Delay(400);sup.StopAll();
 Check(!await wrong,"不能把其它实例的健康响应误认为自身就绪");File.Delete(Path.Combine(root,"wrong-pid"));
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
