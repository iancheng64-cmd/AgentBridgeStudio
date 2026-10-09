const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {ClaudeLocalRuntime}=require('../dist-main/claude-local-runtime');
test('login after connection reloads native credentials before the first turn and unknown probes are visible',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ab-login-transition-')),flag=path.join(dir,'auth.json'),exe=path.join(dir,'claude');
 await fs.writeFile(flag,JSON.stringify({loggedIn:false,authMethod:'none',apiProvider:'firstParty'}));
 await fs.writeFile(exe,`#!${process.execPath}
const fs=require('fs'),auth=JSON.parse(fs.readFileSync(${JSON.stringify(flag)},'utf8'));
if(process.argv.includes('--version')){console.log('2.1.fixture');process.exit(0)}
if(process.argv.includes('auth')){console.log(JSON.stringify(auth));process.exit(0)}
const out=v=>process.stdout.write(JSON.stringify(v)+'\\n');
require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='control_request'){out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{account:{tokenSource:auth.loggedIn?'oauth':'none'},models:[]}}});}else if(m.type==='user'){out({type:'assistant',session_id:'11111111-1111-4111-8111-111111111111',message:{id:'main',content:[{type:'text',text:auth.loggedIn?'fresh credentials':'stale logged-out process'}]}});out({type:'result',session_id:'11111111-1111-4111-8111-111111111111',result:'done'});}});
`,{mode:0o700});
 const events=[],cli=new ClaudeLocalRuntime({cwd:dir,executable:exe,authMode:'api',onEvent:e=>events.push(e)});
 try{
  assert.equal((await cli.start()).account.authenticated,false);
  await fs.writeFile(flag,JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));
  assert.equal((await cli.refreshAccount()).account.authenticated,true);
  await cli.send({requestId:'after-login',prompt:'hello'});
  const end=Date.now()+5000;while(!events.some(e=>e.type==='done')&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
  assert.equal(events.find(e=>e.type==='message')?.text,'fresh credentials');
  await fs.writeFile(flag,JSON.stringify({invalid:'probe-unavailable'}));
  const unknown=await cli.refreshAccount();assert.equal(unknown.account.verified,false);assert.equal(unknown.account.authenticated,false);
 }finally{await cli.stop();await fs.rm(dir,{recursive:true,force:true});}
});
