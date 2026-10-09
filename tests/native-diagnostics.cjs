const {test}=require('node:test');const assert=require('node:assert/strict');
const {nativePermissions,probeNativePermissions}=require('../dist-main/native-diagnostics');
test('MCP structured native permissions preserve false and missing instead of inferring granted',()=>{
 assert.deepEqual(nativePermissions({permissions:{accessibilityTrusted:false,screenRecordingTrusted:true}}),{accessibility:false,screenRecording:true});
 assert.deepEqual(nativePermissions({permissions:{accessibilityTrusted:'true',screenRecordingTrusted:'unavailable'}}),{accessibility:undefined,screenRecording:undefined});
});
test('permission probe calls native MCP doctor without prompting and never accepts mere tool catalog as permission proof',async()=>{
 const program=`require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='tools/list')result={tools:[{name:'doctor',inputSchema:{type:'object'}}]};if(m.method==='tools/call'){if(m.params.name!=='doctor'||m.params.arguments.prompt!==false)process.exit(2);result={structuredContent:{permissions:{accessibilityTrusted:false,screenRecordingTrusted:true}}};}process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')});`;
 const report=await probeNativePermissions({command:process.execPath,args:['-e',program]});assert.equal(report.permissions.accessibilityTrusted,false);
 await assert.rejects(probeNativePermissions({command:process.execPath,args:['-e',program.replace('structuredContent:{permissions:{accessibilityTrusted:false,screenRecordingTrusted:true}}','content:[]')]}),/系統權限/);
});

test('explicit grant request forwards native prompt true; standalone health works without a model and cleans owned processes',async()=>{
 const {StandaloneToolHealth}=require('../dist-main/native-diagnostics');
 const program=`require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='tools/list')result={tools:[{name:'doctor',inputSchema:{type:'object'}},{name:'browser_tabs',inputSchema:{type:'object'}}]};if(m.method==='tools/call')result={content:[],structuredContent:{permissions:{accessibilityTrusted:false,screenRecordingTrusted:false},prompt:m.params.arguments.prompt,pid:process.pid}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')});`;
 const command={command:process.execPath,args:['-e',program]};assert.equal((await probeNativePermissions(command,true)).prompt,true);
 const session=new StandaloneToolHealth({native:command,browser:command});
 try{const [result,concurrent]=await Promise.all([session.health(),session.health()]);assert.equal(result.computer.pid,concurrent.computer.pid);assert.equal(result.scope,'standalone');assert.equal(result.macTools.ok,true);assert.equal(result.browser.ok,true);assert.equal(result.computer.permissions.accessibilityTrusted,false);const pid=result.computer.pid;assert.equal((await session.health()).computer.pid,pid);await session.stop();assert.equal(session.status().ok,false);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}finally{await session.stop();}
});

test('attached native probe uses a real child and cleans it without signaling the App process group',async()=>{
 const program=`require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='tools/list'?{tools:[{name:'doctor',inputSchema:{type:'object'}}]}:m.method==='tools/call'?{structuredContent:{permissions:{accessibilityTrusted:false,screenRecordingTrusted:false}}}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')});`;
 const report=await probeNativePermissions({command:process.execPath,args:['-e',program],detached:false});assert.equal(report.diagnosticProcess.detached,false);assert.equal(report.diagnosticProcess.parentPid,process.pid);assert.throws(()=>process.kill(report.diagnosticProcess.pid,0),{code:'ESRCH'});
});
