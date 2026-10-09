#!/usr/bin/env node
// Isolated headless acceptance: actual production renderer + actual file store.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{ChatHistoryStore}=require('../dist-main/chat-history');
(async()=>{
 const root=path.resolve(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'agentbridge-chat-stress-'));
 const executable=path.join(root,'build/runtime-browsers/chromium-1246/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
 const store=new ChatHistoryStore(path.join(temp,'history'));
 const messages=Array.from({length:1000},(_,i)=>({id:'message-'+i,role:i%2?'assistant':'user',text:`Fixture ${i}\n`+'測試文字。\n'.repeat(250),status:'completed'}));
 messages[messages.length-1].text='['.repeat(32000)+'\n'+'後續測試文字。\n'.repeat(20000);
 const chat={id:'stress-chat',title:'Large chat fixture',agent:'codex',createdAt:1,updatedAt:1,messages};await store.save({ids:[chat.id],changes:[chat]});
 const server=http.createServer(async(req,res)=>{try{const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(root,'dist-renderer','.'+relative+(relative==='/'?'index.html':''));if(!file.startsWith(path.join(root,'dist-renderer')+path.sep))throw Error();res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));}catch{res.writeHead(404);res.end();}});
 let browser;try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,executablePath:executable});const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));const saves=[];
 await page.exposeFunction('__loadHistory',()=>store.load());await page.exposeFunction('__saveHistory',input=>{saves.push(input.changes.length);return store.save(input);});
 await page.addInitScript(()=>{
  const listeners={};window.__fixtureListeners=listeners;const on=key=>callback=>{listeners[key]=callback;return()=>{delete listeners[key]}};
  window.agentBridge={history:{load:()=>window.__loadHistory(),save:input=>window.__saveHistory(input),onFlush:on('flush'),flushed:()=>{}},profiles:{list:async()=>[]},local:{stopToolHealth:async()=>{},network:async()=>[],doctor:async()=>({checks:[]}),computerProvider:async()=>({provider:'bundled'})},exposure:{get:async()=>({mode:'localhost'})},services:{status:async()=>[],onEvent:on('service')},library:{list:async()=>[]},onToast:on('toast'),ssh:{onClosed:on('closed')},chat:{onEvent:on('chat')},orchestrator:{onEvent:on('orchestrator')},runtime:{onEvent:on('runtime')},claude:{onEvent:on('claude')},network:{onEvent:on('network')}};
 });
 const url=`http://127.0.0.1:${server.address().port}/`;await page.goto(url);await page.getByText('Large chat fixture',{exact:true}).first().click();await page.locator('article.message').last().waitFor();
 assert.equal(await page.locator('article.message').count(),40);assert.ok(await page.locator('.message-body').last().innerText().then(s=>s.length<26000));
 const typingStart=Date.now();await page.locator('textarea').fill('輸入測試'.repeat(10000));assert.equal((await page.locator('textarea').inputValue()).length,40000);const typingMs=Date.now()-typingStart;assert.ok(typingMs<1500,`typing stalled ${typingMs}ms`);
 await page.getByRole('button',{name:'下一段',exact:true}).click();assert.ok((await page.locator('.message-body').last().innerText()).includes('第 2 /'));
 await page.getByRole('button',{name:'查看更早訊息',exact:true}).click();assert.equal(await page.locator('article.message').count(),40);await page.getByRole('button',{name:'查看後續訊息',exact:true}).click();assert.equal(await page.locator('article.message').count(),40);
 await page.waitForTimeout(650);assert.ok(saves.every(count=>count===0),'typing rewrote unchanged chat text');assert.deepEqual((await store.load())[0].messages,messages);
 await page.reload();await page.getByText('Large chat fixture',{exact:true}).first().click();assert.equal(await page.locator('article.message').count(),40);assert.deepEqual((await store.load())[0].messages,messages);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({test:'production renderer large chat',messages:1000,longMessageCharacters:messages.at(-1).text.length,mountedMessages:40,typingCharacters:40000,typingMs,unchangedTextWrites:0,reloadPreserved:true,pageErrors:0}));
 // Actual renderer migration from the legacy key; no real user data involved.
 const legacy={...chat,id:'legacy',title:'Migration fixture',messages:[{id:'legacy-message',role:'user',text:'完整保留的測試文字'}]};const legacyStore=new ChatHistoryStore(path.join(temp,'legacy'));
 await page.exposeFunction('__loadLegacy',()=>legacyStore.load());await page.exposeFunction('__saveLegacy',input=>legacyStore.save(input));
 await page.addInitScript(legacy=>{window.agentBridge.history.load=()=>window.__loadLegacy();window.agentBridge.history.save=input=>window.__saveLegacy(input);if(!localStorage.getItem('fixture-seeded')){localStorage.setItem('studio.chats',JSON.stringify([legacy]));localStorage.setItem('fixture-seeded','true');}},legacy);
 await page.reload();await page.getByText('Migration fixture',{exact:true}).first().waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('studio.chats')),null);assert.equal((await legacyStore.load())[0].messages[0].text,legacy.messages[0].text);await page.reload();await page.getByText('Migration fixture',{exact:true}).first().waitFor();assert.deepEqual(errors,[]);
 console.log(JSON.stringify({test:'legacy migration',originalTextPreserved:true,legacyRemovedAfterCommit:true,reloadPreserved:true}));
 await page.addInitScript(()=>{
  localStorage.setItem('studio.autoConnect','false');localStorage.setItem('studio.localCwd',JSON.stringify('/fixture-workspace'));
  const profile={id:'fixture-host',name:'Fixture host',host:'127.0.0.1',username:'fixture',port:22,authType:'agent',runtimePlatform:'posix'};
  window.agentBridge.profiles.list=async()=>[profile];window.agentBridge.profiles.save=async p=>[p];
  window.agentBridge.runtime.connect=async()=>({runtimeId:'fixture-runtime',agent:'codex',status:'connected',runtimePlatform:'posix',account:{authenticated:true,type:'chatgpt'},models:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture Model'}],capabilities:{localTools:true}});
  window.agentBridge.runtime.send=async input=>{window.__fixtureSend=input;return{requestId:input.requestId}};
  window.agentBridge.runtime.usage=async()=>({available:false,buckets:[],updatedAt:Date.now()});
  window.agentBridge.history.flushed=(id,ok)=>{window.__fixtureAck={id,ok}};
 });
 await page.reload();await page.getByRole('button',{name:'設定',exact:true}).click();await page.locator('.settings-nav button').filter({hasText:'連線與 Agent'}).click();
 await page.getByRole('button',{name:'連接 Runtime',exact:true}).click();await page.getByText('Codex 已就緒',{exact:true}).first().waitFor({timeout:5000});await page.getByRole('button',{name:'關閉',exact:true}).click();
 await page.locator('textarea').fill('串流與關閉保存測試');await page.getByRole('button',{name:'傳送訊息',exact:true}).click();
 await page.waitForFunction(()=>!!window.__fixtureSend);
 await page.evaluate(()=>{
  const requestId=window.__fixtureSend.requestId;
  for(let i=0;i<10000;i++)window.__fixtureListeners.runtime({type:'delta',runtimeId:'fixture-runtime',requestId,text:'測試😀'});
  window.__fixtureListeners.flush('close-pending-stream');
 });
 await page.waitForFunction(()=>window.__fixtureAck?.id==='close-pending-stream'&&window.__fixtureAck.ok);
 const streamed=(await legacyStore.load()).find(item=>item.title==='串流與關閉保存測試');assert.equal(streamed.messages.at(-1).text,'測試😀'.repeat(10000));
 await page.evaluate(()=>{window.__fixtureListeners.runtime({type:'done',runtimeId:'fixture-runtime',requestId:window.__fixtureSend.requestId,status:'completed'});});
 await page.waitForFunction(()=>!document.querySelector('.thinking-status'));await page.evaluate(()=>window.__fixtureListeners.flush('close-completed-stream'));await page.waitForFunction(()=>window.__fixtureAck?.id==='close-completed-stream'&&window.__fixtureAck.ok);
 assert.equal((await legacyStore.load()).find(item=>item.title==='串流與關閉保存測試').messages.at(-1).status,'completed');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({test:'streaming and close flush',deltaEvents:10000,characters:40000,lastPendingTextPreserved:true,completedStatusPreserved:true,pageErrors:0}));

 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await fs.rm(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
