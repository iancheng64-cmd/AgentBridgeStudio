const {test,after}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {ClaudeLocalRuntime,claudeArguments}=require('../dist-main/claude-local-runtime');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ab-claude-native-test-')),marker=path.join(root,'approved.txt'),argvLog=path.join(root,'argv.jsonl'),fake=path.join(root,'claude');after(()=>fs.rmSync(root,{recursive:true,force:true}));
fs.writeFileSync(fake,`#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(argvLog)},JSON.stringify(process.argv)+'\\n');
const rl=require('node:readline').createInterface({input:process.stdin});const out=v=>process.stdout.write(JSON.stringify(v)+'\\n');
if(process.argv.includes('--version')){console.log('2.1.fixture');process.exit(0)}if(process.argv.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'oauth',apiProvider:'firstParty'}));process.exit(0)}
let active;const session='11111111-1111-4111-8111-111111111111';const done=()=>out({type:'result',session_id:session,usage:{input_tokens:3,cache_read_input_tokens:4,cache_creation_input_tokens:2,output_tokens:5},result:'已完成'});
rl.on('line',line=>{const m=JSON.parse(line);if(m.type==='control_request'){out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:m.request.subtype==='initialize'?{account:{tokenSource:'oauth'},models:[{value:'sonnet',displayName:'Native Sonnet',supportedEffortLevels:['high']}],commands:[{name:'fixture-skill'}]}:{mcpServers:[]}}});return}
if(m.type==='user'){const text=m.message.content[0].text;out({type:'system',subtype:'init',session_id:session,plugins:[{name:'native-plugin'}]});if(text==='wait')return;if(text==='approval'){active='permission-fixture';out({type:'control_request',request_id:active,request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:${JSON.stringify(marker)}}}});return;}out({type:'assistant',session_id:session,parent_tool_use_id:'subagent',message:{id:'nested',content:[{type:'text',text:'not main'}]}});out({type:'assistant',session_id:session,message:{id:'main',content:[{type:'text',text:'原生回覆'}]}});done();}
if(m.type==='control_response'&&m.response.request_id===active){if(m.response.response.behavior==='allow')require('node:fs').writeFileSync(${JSON.stringify(marker)},'approved');done();}});
`,{mode:0o755});
const waitFor=(events,predicate)=>new Promise((resolve,reject)=>{const limit=Date.now()+6000;const poll=()=>{if(events.some(predicate))return resolve();if(Date.now()>limit)return reject(new Error('fixture timeout'));setTimeout(poll,10)};poll();});
test('native local runtime streams main replies, reports real turn counts, approval result and resumes after cancellation',async()=>{
 const events=[];let allow=false;const cli=new ClaudeLocalRuntime({cwd:root,executable:fake,authMode:'api',permissionMode:'ask',onEvent:e=>events.push(e),onPermission:async()=>({allow})});
 try{const status=await cli.start();assert.equal(status.account.authenticated,true);assert.equal(status.models[0].id,'sonnet');
 await cli.send({requestId:'first',prompt:'text',model:'sonnet'});await waitFor(events,e=>e.type==='done'&&e.requestId==='first');assert.equal(events.filter(e=>e.type==='message').at(-1).text,'原生回覆');assert.ok(!events.some(e=>e.text==='not main'));assert.equal(events.find(e=>e.type==='usage').usage.totalTokens,14);assert.equal((await cli.extensions()).plugins[0].name,'native-plugin');
 await cli.send({requestId:'deny',prompt:'approval',conversationId:'11111111-1111-4111-8111-111111111111'});await waitFor(events,e=>e.type==='done'&&e.requestId==='deny');assert.ok(!fs.existsSync(marker));
 allow=true;await cli.send({requestId:'allow',prompt:'approval',conversationId:'11111111-1111-4111-8111-111111111111'});await waitFor(events,e=>e.type==='done'&&e.requestId==='allow');assert.equal(fs.readFileSync(marker,'utf8'),'approved');
 await cli.send({requestId:'cancel',prompt:'wait',conversationId:'11111111-1111-4111-8111-111111111111'});assert.equal((await cli.cancel('cancel')).cancelled,true);assert.ok(events.some(e=>e.type==='done'&&e.requestId==='cancel'&&e.status==='cancelled'));
 await cli.send({requestId:'after',prompt:'text',conversationId:'11111111-1111-4111-8111-111111111111'});await waitFor(events,e=>e.type==='done'&&e.requestId==='after');
 }finally{await cli.stop();}
});
test('native argv never contains MCP bearer secret and rejects invalid model/remote MCP URLs',()=>{
 const args=claudeArguments({cwd:root,mcp:{url:'http://127.0.0.1:1234/mcp',token:'fixture-secret'}});assert.ok(!args.join(' ').includes('fixture-secret'));assert.ok(args.join(' ').includes('${AGENTBRIDGE_MAC_MCP_TOKEN}'));assert.throws(()=>claudeArguments({cwd:root,model:'invalid model'}),/模型/);assert.throws(()=>claudeArguments({cwd:root,mcp:{url:'https://remote.invalid/mcp',token:'fixture'}}),/loopback/);
});


test('changing permission mode relaunches the next native turn with bypassPermissions rather than only relabeling status',async()=>{
 const events=[];const cli=new ClaudeLocalRuntime({cwd:root,executable:fake,authMode:'api',permissionMode:'ask',onEvent:e=>events.push(e),onPermission:async()=>({allow:true})});
 try{await cli.start();cli.setPermissionMode('full');assert.equal(cli.status().permissionMode,'full');await cli.send({requestId:'changed-permission',prompt:'text'});await waitFor(events,e=>e.type==='done'&&e.requestId==='changed-permission');
 const launches=fs.readFileSync(argvLog,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(args=>args.includes('--permission-mode'));assert.equal(launches.at(-1)[launches.at(-1).indexOf('--permission-mode')+1],'bypassPermissions');
 }finally{await cli.stop();}
});


test('an active bypass turn cannot be relabeled as lower permission until stopped',async()=>{
 const events=[];const cli=new ClaudeLocalRuntime({cwd:root,executable:fake,authMode:'api',permissionMode:'full',onEvent:e=>events.push(e)});
 try{await cli.start();await cli.send({requestId:'downgrade-busy',prompt:'wait'});assert.throws(()=>cli.setPermissionMode('ask'),/先停止/);assert.equal(cli.status().permissionMode,'full');await cli.cancel('downgrade-busy');cli.setPermissionMode('ask');assert.equal(cli.status().permissionMode,'ask');}finally{await cli.stop();}
});
