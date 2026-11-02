'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const policy=require('../src/core/voiceReply');
test('explicit voice requests are distinguished from negation and discussion',()=>{
  for(const text of ['发一条语音听听','用语音回复我','说句语音'])assert.equal(policy.requested(text),true,text);
  for(const text of ['别发语音','不要发语音','怎么发语音','他说发一条语音','“发条语音”是什么意思'])assert.equal(policy.requested(text),false,text);
});
test('voice enable and per-chat scope are read live and default off',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auto-voice-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const config={paths:{dataDir:dir}};assert.equal(policy.enabled(config,true),false);
  fs.writeFileSync(path.join(dir,'voice-send.json'),JSON.stringify({Enabled:true,Groups:false,Private:true}));
  assert.equal(policy.enabled(config,true),false);assert.equal(policy.enabled(config,false),true);
  fs.writeFileSync(path.join(dir,'voice-send.json'),JSON.stringify({Enabled:'true'}));assert.equal(policy.enabled(config,false),false);
});
test('voice request reaches the normal group reply model without replacing the reply content',async t=>{
  const {Bot}=require('../src/pipeline/chat');const {Store}=require('../src/memory/store');const {loadConfig}=require('../src/infra/config');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auto-voice-chat-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({group:{requireAt:true,freeChat:false},care:{enabled:false}}));
  const config=loadConfig({root:dir,env:{}});fs.mkdirSync(config.paths.dataDir,{recursive:true});
  fs.writeFileSync(path.join(config.paths.dataDir,'voice-send.json'),JSON.stringify({Enabled:true,Probability:0}));
  const store=new Store({file:path.join(config.paths.dataDir,'store.json')});t.after(()=>store.close());
  const bot=new Bot({config,store,llm:{isMock:true,model:'mock',reload(){},describe(){return{}}},rng:()=>.99,mockChunkDelayMs:0});
  const decision=await bot.decide({platform:'wechat',chatId:'test@chatroom',chatType:'group',senderId:'test',senderName:'测试用户',text:'发一条语音听听'});
  assert.equal(decision.action,'reply');assert.match(decision.system,/发送层会把正文转成语音/);
});
