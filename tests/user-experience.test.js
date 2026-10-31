'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sourceRoot = process.env.WHALE_AUDIT_SOURCE || path.join(__dirname, '..');
const source = relative => require(path.join(sourceRoot, relative));
const { startServer } = source('server');
const { Store, readStoreFile } = source('src/memory/store');
const { loadConfig } = source('src/infra/config');
const backup = source('src/memory/backup');
const stickers = source('src/adapters/stickers');
const { StickerService } = source('src/services/stickerService');
const { refreshWechatAccounts } = source('src/services/wechat');
const vision = source('src/adapters/vision');
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-ux-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:60}));
 return root;
}
async function boot(t) {
 const root=fixture(t);
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({watchConfig:false,server:{openBrowser:false}}));
 const app=await startServer({root,env:{},port:0,openBrowser:false});
 t.after(()=>app.close()); return app;
}

test('旧快照与增量读取仍兼容，迁移后继续使用记忆 v2',t=>{
 const root=fixture(t),file=path.join(root,'store.json');
 fs.writeFileSync(file,JSON.stringify({version:1,sessions:{}}));
 fs.writeFileSync(file+'.journal',JSON.stringify({sessions:{legacy:{messages:[{text:'旧格式'}],profiles:{}}}})+'\n');
 assert.equal(readStoreFile(file).sessions.legacy.messages[0].text,'旧格式');
 const store=new Store({file});t.after(()=>store.close());
 store.appendMessage('new',{text:'新格式'});store.flush();
 const reopened=new Store({file});t.after(()=>reopened.close());
 assert.equal(reopened.messages('new',1)[0].text,'新格式');
});

test('手动重复点击同一会话发送表情包，只保留一个进行中任务',t=>{
 const root=fixture(t),cfg=loadConfig({root,env:{}});cfg.features.stickers=true;
 stickers.upload(cfg,root,'other',[{name:'a.gif',data:'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='}]);
 const service=new StickerService(cfg);const first=service.enqueue('other','文件传输助手');
 const repeat=service.enqueue('other','文件传输助手');
 assert.equal(first.id,repeat.id);assert.equal(service.pending().length,1);
 service.claim(first.id);service.ack(first.id,'confirmed');
 assert.notEqual(service.enqueue('other','文件传输助手').id,first.id);
});

test('JSON 数组、null 和字符串返回 400，健康检查包含实例身份',async t=>{
 const app=await boot(t);const health=await(await fetch(app.url+'/healthz')).json();
 assert.equal(health.service,'whale-girl');assert.equal(health.pid,process.pid);
 for(const body of ['null','[]','"text"']) {
  const res=await fetch(app.url+'/api/settings',{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(res.status,400);
 }
});

test('大于2MB的合法图片请求可以进入视觉服务，超限请求保留413',async t=>{
 const app=await boot(t);const previous=vision.describe;
 vision.describe=async(config,input)=> {assert.ok(input.imageBase64.length>2*1024*1024);return '识别结果';};
 try {
  const res=await fetch(app.url+'/api/vision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({image:'A'.repeat(3*1024*1024),mime:'image/jpeg'})});
  assert.equal(res.status,200);assert.equal((await res.json()).text,'识别结果');
  const tooLarge=await fetch(app.url+'/api/vision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({image:'A'.repeat(13*1024*1024)})});assert.equal(tooLarge.status,413);
 } finally {vision.describe=previous;}
});

test('账号扫描子进程失败时，不把以前的账号缓存冒充刷新成功',async t=>{
 const root=fixture(t),cfg=loadConfig({root,env:{}});
 fs.mkdirSync(path.join(root,'runtime/python'),{recursive:true});fs.mkdirSync(path.join(root,'examples'));
 fs.mkdirSync(cfg.paths.dataDir,{recursive:true});
 fs.writeFileSync(path.join(root,'examples/wechatauto_bridge.py'),'');
 fs.writeFileSync(path.join(cfg.paths.dataDir,'accounts.json'),JSON.stringify({accounts:[{account:'old'}]}));
 fs.copyFileSync(process.execPath,path.join(root,'runtime/python/python.exe'));
 const out=await refreshWechatAccounts({config:cfg,logger:{info(){}}},3000);
 assert.equal(out.ok,false);
});

test('桥接表情包安全检查不扫描图库，且仍需要 token',async t=>{
 const app=await boot(t);app.runtime.config.features.stickers=true;
 app.runtime.stickerService.reconcile();
 const previous=stickers.categoryImages;
 stickers.categoryImages=()=>{throw Error('gate must not enumerate images');};
 try {
  const forbidden=await fetch(app.url+'/api/stickers/gate');assert.equal(forbidden.status,403);
  const res=await fetch(app.url+'/api/stickers/gate',{headers:{'x-bot-token':app.runtime.config.gateway.wechat.inboundToken}});
  assert.equal(res.status,200);const gate=await res.json();assert.equal(gate.enabled,true);assert.ok(gate.generation);assert.deepEqual(gate.jobs,[]);
 }finally {stickers.categoryImages=previous;}
});

test('桥接用户流程与语音凭据隔离的离线回归',t=>{
 const {spawnSync}=require('node:child_process');
 const bundled=path.join(__dirname,'../runtime/python/python.exe');
 const exe=fs.existsSync(bundled)?bundled:'python';
 const out=spawnSync(exe,['-B','-m','unittest','discover','-s',__dirname,'-p','test_user_flows.py'],{encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONUTF8:'1'},timeout:15000});
 if(out.error?.code==='ENOENT')return t.skip('未找到Python');
 assert.equal(out.status,0,(out.stderr||'')+(out.stdout||''));
});

test('未授权聊天请求返回404后立即结束，不进入模型或记忆处理',async()=>{
 const {Readable}=require('node:stream'); const {EventEmitter}=require('node:events');
 let handler,decisions=0,writes=0;
 source('src/http/routes/chat')({post(route,fn){if(route==='/api/chat')handler=fn;}});
 const req=Readable.from([Buffer.from(JSON.stringify({text:'不得处理'}))]);req.headers={};req.socket={remoteAddress:'127.0.0.1'};
 const res=new EventEmitter();res.writeHead=()=>{writes++;};res.end=()=>{};
 const runtime={gateways:new Map(),config:{persona:{}},logger:{error(){}},bot:{async decide(){decisions++;return {action:'ignore'};}}};
 await handler(runtime,req,res);
 assert.equal(writes,1);assert.equal(decisions,0);
});

test('客户端中断上传时，读请求体立即结束而不是永久等待',async()=>{
 const {EventEmitter}=require('node:events');const {readBody}=source('src/http/protocol');
 const req=new EventEmitter();const read=readBody(req);
 req.emit('data',Buffer.from('{'));req.emit('aborted');
 const result=await Promise.race([read.then(()=>false,e=>e.statusCode===400),new Promise(r=>setTimeout(()=>r(false),100))]);
 assert.equal(result,true);
});

test('非法 URL 编码返回400，特殊用户标识不能污染其他会话',async t=>{
 const app=await boot(t);const res=await fetch(app.url+'/%FF');assert.equal(res.status,400);
 const store=app.runtime.store;
 for(const uid of ['__proto__','constructor','toString']) {
  const profile=store.profile('audit',uid,'测试');assert.equal(profile.uid,uid);assert.equal(profile.count,1);
 }
 assert.equal(Object.prototype.count,undefined);assert.equal(Object.prototype.nickname,undefined);
 assert.equal(store.profile('other','normal','正常').count,1);
});

test('正常停止仅压缩记忆一次，重复关闭不重复写快照',async t=>{
 const app=await boot(t);let closes=0;const original=app.runtime.store.close.bind(app.runtime.store);
 app.runtime.store.close=()=>{closes++;original();};
 await app.close();await app.close();assert.equal(closes,1);
});

test('命令行记忆工具可运行，服务在线时拒绝直接覆盖磁盘记忆',async t=>{
 const {spawnSync}=require('node:child_process');const net=require('node:net');
 const root=fixture(t);fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'data'));
 fs.cpSync(path.join(__dirname,'../src'),path.join(root,'src'),{recursive:true});
 fs.copyFileSync(path.join(__dirname,'../scripts/memory-tool.js'),path.join(root,'scripts/memory-tool.js'));
 fs.writeFileSync(path.join(root,'data/store.json'),JSON.stringify({sessions:{}}));
 const script=path.join(root,'scripts/memory-tool.js');
 const info=spawnSync(process.execPath,[script,'info'],{encoding:'utf8',windowsHide:true});assert.equal(info.status,0,info.stderr);
 const listener=net.createServer(socket=>socket.end());await new Promise(r=>listener.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>listener.close(r)));
 fs.writeFileSync(path.join(root,'data/server-port.txt'),String(listener.address().port));
 const bundle=path.join(root,'bundle.json');fs.writeFileSync(bundle,JSON.stringify({kind:'whale-girl-memory',files:{store:{sessions:{wouldOverwrite:{messages:[],profiles:{}}}}}}));
 // Asynchronous child: the parent must remain able to accept its connection probe.
 const {spawn}=require('node:child_process');const child=spawn(process.execPath,[script,'restore',bundle],{windowsHide:true,stdio:'ignore'});
 const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
 assert.equal(code,1);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'data/store.json'),'utf8')).sessions,{});
});

test('恢复出厂在备份失败时立即停止，不执行任何删除',t=>{
 if(process.platform!=='win32')return t.skip('Windows脚本');
 const {spawnSync}=require('node:child_process');const root=fixture(t),scripts=path.join(root,'scripts');fs.mkdirSync(scripts);
 fs.writeFileSync(path.join(root,'config.json'),'KEEP-ORIGINAL');
 fs.writeFileSync(path.join(scripts,'stop-all.ps1'),'param([switch]$Quiet)\nexit 0');
 fs.copyFileSync(path.join(__dirname,'../scripts/factory-reset.ps1'),path.join(scripts,'factory-reset.ps1'));
 const harness=path.join(root,'harness.ps1');
 fs.writeFileSync(harness,'\uFEFF'+String.raw`
function Copy-Item { param($LiteralPath,$Destination,[switch]$Recurse,[switch]$Force,$ErrorAction) throw 'SIMULATED BACKUP FAILURE' }
function Remove-Item { param($LiteralPath,[switch]$Recurse,[switch]$Force,$ErrorAction) [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'delete-attempted'),'yes'); throw 'MUST NOT DELETE' }
& (Join-Path $PSScriptRoot 'scripts\factory-reset.ps1') -Yes -NoStart
`,'utf8');
 const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',harness],{encoding:'utf8',windowsHide:true,timeout:10000});
 assert.notEqual(result.status,0);assert.equal(fs.existsSync(path.join(root,'delete-attempted')),false,result.stdout+result.stderr);
 assert.equal(fs.readFileSync(path.join(root,'config.json'),'utf8'),'KEEP-ORIGINAL');
});

test('记忆v2停止准备接口只返回结果，要求本机令牌且拒绝未保存状态',async t=>{
 const app=await boot(t);const route=app.url+'/api/runtime/prepare-stop';
 assert.equal((await fetch(route,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
 const headers={'content-type':'application/json','x-bot-token':app.runtime.config.gateway.wechat.inboundToken};
 app.runtime.store.appendMessage('private-test',{role:'user',text:'不应出现在响应里'});
 const res=await fetch(route,{method:'POST',headers,body:'{}'});assert.equal(res.status,200);assert.deepEqual(await res.json(),{ok:true});
 const chat=[...app.runtime.store.chatStore.chats.values()][0];
 const write=fs.writeFileSync;
 fs.writeFileSync=function(file,...args){if(String(file).startsWith(path.join(chat.dir,'meta.json')))throw Error('SIMULATED META WRITE FAILURE');return write.call(this,file,...args);};
 try {
  app.runtime.store.chatStore.saveMeta(chat,{immediate:true});
  assert.equal((await fetch(route,{method:'POST',headers,body:'{}'})).status,503);
 }finally{fs.writeFileSync=write;}
 assert.equal((await fetch(app.url+'/api/memory/export')).status,404);
});
