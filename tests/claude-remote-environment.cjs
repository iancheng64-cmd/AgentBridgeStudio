const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {nativeClaudeDirectoryEnv,resolveNativeRemoteClaude}=require('../dist-main/claude-remote-environment');
function run(fn,platform,env={},modules={}){return vm.runInNewContext('('+fn.toString()+')',{process:{platform,env},require:n=>modules[n]||require(n)});}
test('SSH fills only missing Claude directory settings from the selected Windows user; inherited overrides and empty pin survive',()=>{
 const f=run(nativeClaudeDirectoryEnv,'win32',{}, {'node:child_process':{execFileSync:(exe,args,options)=>{assert.equal(exe,'powershell.exe');assert.ok(args.includes('-NoProfile'));assert.equal(options.stdio[2],'ignore');return JSON.stringify({CLAUDE_CONFIG_DIR:'C:\\fixture\\config',CLAUDE_SECURESTORAGE_CONFIG_DIR:'',ANTHROPIC_API_KEY:'must-ignore'});}}});
 const env=f({CLAUDE_CONFIG_DIR:'C:\\explicit'});assert.equal(env.CLAUDE_CONFIG_DIR,'C:\\explicit');assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR,'');assert.equal(env.ANTHROPIC_API_KEY,undefined);assert.equal(f({}).CLAUDE_CONFIG_DIR,'C:\\fixture\\config');
 assert.equal(run(nativeClaudeDirectoryEnv,'darwin')({CLAUDE_CONFIG_DIR:'fixture'}).CLAUDE_CONFIG_DIR,'fixture');
});
test('noninteractive Mac SSH finds native Claude without a Homebrew PATH; an explicit path never silently selects another CLI',()=>{
 const f=run(resolveNativeRemoteClaude,'darwin',{PATH:'/usr/bin'}, {'node:fs':{constants:{X_OK:1},statSync:file=>{if(file==='/opt/homebrew/bin/claude')return{isFile:()=>true};throw Error('missing');},accessSync:()=>{}},'node:os':{homedir:()=>'/fixture/home'}});
 assert.equal(f(),'/opt/homebrew/bin/claude');assert.equal(f('claude'),'/opt/homebrew/bin/claude');assert.equal(f('/explicit/missing'),'/explicit/missing');assert.throws(()=>f('bad\ncommand'),/invalid/);
});
