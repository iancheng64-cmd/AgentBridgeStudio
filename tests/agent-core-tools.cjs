const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {LocalToolHost}=require('../dist-main/local-tool-host');
async function fixture(options={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentbridge-core-')));
 const host=new LocalToolHost({allowedRoots:[root],stateDirectory:path.join(root,'state'),authorize:()=>true,...options});
 const endpoint=await host.start();let id=0;
 const raw=async(name,args={})=>(await(await fetch(endpoint.url,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}})})).json());
 const call=async(name,args)=>{const response=await raw(name,args);assert.equal(response.error,undefined,JSON.stringify(response));assert.notEqual(response.result.isError,true,JSON.stringify(response.result));return JSON.parse(response.result.content[0].text);};
 return {root,host,raw,call,cleanup:async()=>{await host.stop();await fs.rm(root,{recursive:true,force:true});}};
}
test('filename search continues after a denied descendant and reports incomplete coverage',async()=>{
 const f=await fixture();const denied=path.join(f.root,'private');
 try{await fs.mkdir(denied);await fs.writeFile(path.join(f.root,'found.txt'),'yes');await fs.chmod(denied,0);
 const response=await f.call('mac_fs_search',{root:f.root,query:'*.txt'});assert.deepEqual(response.matches,[path.join(f.root,'found.txt')]);assert.equal(response.skippedDirectories,1);assert.equal(response.complete,false);
 }finally{await fs.chmod(denied,0o700);await f.cleanup();}
});
test('content search handles binary, inaccessible and large files without aborting; patch rejects stale or ambiguous edits and preserves permissions',async()=>{
 const f=await fixture();try{
 const file=path.join(f.root,'script.sh');await fs.writeFile(file,'needle\nneedle\n',{mode:0o755});await fs.writeFile(path.join(f.root,'binary.bin'),Buffer.from([0,110,101,101,100,108,101]));
 const grep=await f.call('mac_fs_grep',{root:f.root,query:'needle'});assert.equal(grep.matches.length,2);assert.equal(grep.skippedFiles,1);
 const bad=await f.raw('mac_fs_patch',{path:file,before:'needle',after:'new'});assert.equal(bad.result.isError,true);assert.equal(await fs.readFile(file,'utf8'),'needle\nneedle\n');
 const result=await f.call('mac_fs_patch',{path:file,before:'needle\nneedle\n',after:'new\n'});assert.equal(result.replacements,1);assert.equal((await fs.stat(file)).mode&0o777,0o755);
 assert.equal((await f.raw('mac_fs_patch',{path:file,before:'new',after:'stale',expectedSha256:'0'.repeat(64)})).result.isError,true);
 assert.equal((await f.raw('mac_fs_grep',{root:path.dirname(f.root),query:'needle'})).result.isError,true);
 }finally{await f.cleanup();}
});
test('task checkpoints persist across host restart and reject lost updates',async()=>{
 const f=await fixture();try{
 let plan=await f.call('mac_task_plan',{action:'save',goal:'finish project',steps:[{text:'write',status:'completed'},{text:'verify',status:'in_progress'}],nextAction:'run test',expectedRevision:0});assert.equal(plan.revision,1);
 await f.host.stop();const endpoint=await f.host.start(); // fixture caller keeps old URL; use a fresh authenticated request
 const request=async(args)=>(await(await fetch(endpoint.url,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'mac_task_plan',arguments:args}})})).json()).result;
 const saved=JSON.parse((await request({action:'read'})).content[0].text);assert.equal(saved.goal,'finish project');assert.equal(saved.nextAction,'run test');
 assert.equal((await request({action:'save',goal:'overwrite',steps:[],expectedRevision:0})).isError,true);
 }finally{await f.cleanup();}
});
test('local processes accept stdin, expose cursor output and are cancelled without orphans',async()=>{
 const f=await fixture();try{
 const job=await f.call('mac_process_start',{command:JSON.stringify(process.execPath)+' -e '+"'process.stdin.on(\"data\",x=>{console.log(x.toString().trim());process.exit(0)})'",cwd:f.root});
 await f.call('mac_process_input',{id:job.id,text:'hello\n'});let status;
 for(let n=0;n<30;n++){status=await f.call('mac_process_status',{id:job.id});if(status.state!=='running')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(status.state,'completed');assert.equal(status.exitCode,0);assert.match(status.output,/hello/);
 assert.equal((await f.call('mac_process_status',{id:job.id,after:status.nextCursor})).output,'');
 const running=await f.call('mac_process_start',{command:'sleep 30',cwd:f.root});f.host.cancelActive();
 await new Promise(r=>setTimeout(r,50));const cancelled=await f.call('mac_process_status',{id:running.id});assert.equal(cancelled.state,'cancelled');assert.throws(()=>process.kill(running.pid,0));
 }finally{await f.cleanup();}
});
test('process and plan mutations honor denied authorization',async()=>{
 const f=await fixture({authorize:call=>call.category==='filesystem-read'});try{
 assert.equal((await f.raw('mac_process_start',{command:'touch forbidden'})).result.isError,true);
 assert.equal((await f.raw('mac_task_plan',{action:'save',goal:'no',steps:[],expectedRevision:0})).result.isError,true);
 await assert.rejects(fs.stat(path.join(f.root,'forbidden')),{code:'ENOENT'});
 }finally{await f.cleanup();}
});
test('web reader follows bounded redirects, enforces size limits, and exposes actual capability and built-in guides',async()=>{
 const server=http.createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:'/ok'});res.end();}else if(req.url==='/large'){res.end('x'.repeat(1500000));}else{res.setHeader('Content-Type','text/html');res.end('<title>Fixture</title><script>secretScript()</script><p>實際網頁</p>');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const f=await fixture();try{
 const web=await f.call('mac_web_fetch',{url:`http://127.0.0.1:${server.address().port}/redirect`});assert.match(web.text,/實際網頁/);assert.doesNotMatch(web.text,/secretScript/);assert.equal(web.status,200);
 assert.equal((await f.raw('mac_web_fetch',{url:`http://127.0.0.1:${server.address().port}/large`})).result.isError,true);
 assert.equal((await f.raw('mac_web_fetch',{url:'file:///etc/passwd'})).result.isError,true);
 const capabilities=await f.call('mac_agent_capabilities');assert.ok(capabilities.tools.some(t=>t.name==='mac_fs_patch'));assert.equal(capabilities.computer,'unavailable');assert.equal(capabilities.builtInGuides.length,4);
 const guide=await f.call('mac_agent_guide',{topic:'coding'});assert.match(guide.instructions,/AGENTS.md/);assert.match(guide.instructions,/verify/i);
 }finally{await f.cleanup();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('bundled Node runtime needs no external node; invalid timeouts never start a process; output is bounded',async()=>{
 const f=await fixture();try{
 assert.equal((await f.raw('mac_process_start',{command:'touch invalid-timeout',timeoutMs:-1})).result.isError,true);await assert.rejects(fs.stat(path.join(f.root,'invalid-timeout')),{code:'ENOENT'});
 const job=await f.call('mac_process_start',{runtime:'node',command:'process.stdout.write("繁體".repeat(100000));setTimeout(()=>process.exit(0),10)'});let status;
 for(let i=0;i<40;i++){status=await f.call('mac_process_status',{id:job.id});if(status.state!=='running')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(status.exitCode,0);assert.equal(status.truncated,true);assert.ok(status.output.length<=128*1024);assert.doesNotMatch(status.output,/�/);
 const timeout=await f.call('mac_process_start',{runtime:'node',command:'setInterval(()=>{},1000)',timeoutMs:100});await new Promise(r=>setTimeout(r,180));assert.equal((await f.call('mac_process_status',{id:timeout.id})).state,'timeout');
 }finally{await f.cleanup();}
});
test('independent task checkpoints remain separate and read is allowed in read-only authorization',async()=>{
 const f=await fixture();try{
 await f.call('mac_task_plan',{action:'save',taskId:'first',goal:'first goal',steps:[],expectedRevision:0});await f.call('mac_task_plan',{action:'save',taskId:'second',goal:'second goal',steps:[],expectedRevision:0});
 assert.equal((await f.call('mac_task_plan',{action:'read',taskId:'first'})).goal,'first goal');assert.equal((await f.call('mac_task_plan',{action:'read',taskId:'second'})).goal,'second goal');
 }finally{await f.cleanup();}
 const readonly=await fixture({authorize:call=>call.category==='filesystem-read'});try{assert.equal((await readonly.call('mac_task_plan',{action:'read'})).revision,0);}finally{await readonly.cleanup();}
});
