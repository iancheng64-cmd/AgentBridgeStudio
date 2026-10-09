const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {ChatHistoryStore}=require('../dist-main/chat-history');
const fixture=async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'agentbridge-history-test-'));return{root,store:new ChatHistoryStore(root),file:id=>path.join(root,crypto.createHash('sha256').update(id).digest('hex')+'.json'),close:()=>fs.rm(root,{recursive:true,force:true})};};
test('history exceeds the browser localStorage quota and only changed chats are written',async()=>{
 const f=await fixture();try{
 assert.equal(await f.store.load(),null);const large={id:'large',title:'large',messages:[{id:'m',role:'assistant',text:'測'.repeat(6*1024*1024)}]},small={id:'small',title:'small',messages:[]};
 await f.store.save({ids:['large','small'],changes:[large,small]});const before=(await fs.stat(f.file('large'))).mtimeMs;
 await f.store.save({ids:['large','small'],changes:[{...small,title:'changed'}]});assert.equal((await fs.stat(f.file('large'))).mtimeMs,before);const loaded=await f.store.load();assert.equal(loaded[0].messages[0].text.length,large.messages[0].text.length);assert.equal(loaded[1].title,'changed');assert.equal((await fs.stat(f.file('large'))).mode&0o777,0o600);
 await f.store.save({ids:['small'],changes:[]});await assert.rejects(fs.stat(f.file('large')),{code:'ENOENT'});assert.equal((await f.store.load()).length,1);
 }finally{await f.close();}
});
test('queued saves commit in order and corrupted history is never overwritten',async()=>{
 const f=await fixture();try{
 const chat={id:'../safe',title:'first',messages:[]};await Promise.all([f.store.save({ids:[chat.id],changes:[chat]}),f.store.save({ids:[chat.id],changes:[{...chat,title:'second'}]})]);assert.equal((await f.store.load())[0].title,'second');
 await assert.rejects(f.store.save({ids:['missing'],changes:[]}));assert.equal((await f.store.load())[0].title,'second');
 await fs.writeFile(path.join(f.root,'index.json'),'broken');await assert.rejects(f.store.load());await assert.rejects(f.store.save({ids:[],changes:[]}));assert.equal(await fs.readFile(path.join(f.root,'index.json'),'utf8'),'broken');
 }finally{await f.close();}
});
