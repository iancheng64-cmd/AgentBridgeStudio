const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
function reader({credentials,env={},platform='darwin',keychain,requests=[]}){
 const mocks={'node:fs':{readFileSync:(file)=>{requests.push({file});if(credentials)return JSON.stringify(credentials);throw Object.assign(Error('missing'),{code:'ENOENT'});}},'node:path':require('node:path'),'node:os':{homedir:()=>'/fixture/home',userInfo:()=>({username:'fixture'})},'node:crypto':crypto,'node:child_process':{execFileSync:(file,args)=>{requests.push(args);if(keychain)return JSON.stringify(keychain);throw Error('locked');}},'node:https':{request:(url,options,callback)=>{requests.push({url,authorization:options.headers.Authorization});const req=new EventEmitter();req.setTimeout=()=>req;req.end=()=>{const res=new EventEmitter();res.statusCode=200;callback(res);queueMicrotask(()=>{res.emit('data',Buffer.from('{"five_hour":{"utilization":25},"seven_day":{"utilization":40},"accessToken":"must-not-export"}'));res.emit('end');});};return req;}}};
 const context={exports:{},require:name=>mocks[name],process:{env,platform},Buffer};vm.createContext(context);
 if(process.env.AGENTBRIDGE_BASELINE_ASAR){const source=require('@electron/asar').extractFile(process.env.AGENTBRIDGE_BASELINE_ASAR,'dist-main/claude-usage-reader.js').toString();vm.runInContext(source,context);return context.exports.readClaudeSubscriptionUsage;}
 return vm.runInContext('('+require('../dist-main/claude-usage-reader').readClaudeSubscriptionUsage.toString()+')',context);
}
test('native Mac credentials use the current Keychain before a stale file and only export usage',async()=>{
 const requests=[];const result=await reader({credentials:{claudeAiOauth:{accessToken:'old',expiresAt:1}},keychain:{claudeAiOauth:{accessToken:'fresh',expiresAt:Date.now()+60000}},requests})();
 assert.equal(result.ok,true);assert.equal(requests[1].authorization,'Bearer fresh');assert.ok(!JSON.stringify(result).includes('Token'));assert.ok(!JSON.stringify(result).includes('fresh'));
});
test('custom Mac configuration selects only its native namespaced Keychain account',async()=>{
 const config='/fixture/claude-work',requests=[];const result=await reader({env:{CLAUDE_CONFIG_DIR:config,USER:'fixture'},keychain:{claudeAiOauth:{accessToken:'work'}},requests})(config);
 assert.equal(result.ok,true);const args=requests[0];assert.ok(args.includes('Claude Code-credentials-'+crypto.createHash('sha256').update(config).digest('hex').slice(0,8)));assert.equal(args[args.indexOf('-a')+1],'fixture');
});
test('Windows credential absence is distinct from failed storage reads; API credentials do not masquerade as subscription',async()=>{
 assert.equal((await reader({platform:'win32'})()).code,'NO_OAUTH');assert.equal((await reader({platform:'win32',credentials:{apiKey:'private'}})()).code,'NO_OAUTH');
});
test('native auth probe preserves a real logged-out response and distinguishes unsupported schema from logout',()=>{
 const {readNativeClaudeAuthStatus}=require('../dist-main/claude-auth-probe');
 const run=(stdout,throws=false)=>vm.runInNewContext('('+readNativeClaudeAuthStatus.toString()+')',{require:name=>name==='node:crypto'?crypto:({execFileSync:()=>{if(throws)throw{stdout};return stdout;}})})('claude',[],{},'/fixture');
 assert.equal(run('{"loggedIn":false}',true).verified,true);assert.equal(run('unsupported').verified,false);assert.equal(run('{"loggedIn":true,"authMethod":"claude.ai","accessToken":"secret"}').authenticated,true);assert.ok(!JSON.stringify(run('{"loggedIn":true,"accessToken":"secret"}')).includes('secret'));
});

test('native separate secure-storage directory and explicit empty value override the config directory',async()=>{for(const [secure,expected] of [['/fixture/login','/fixture/login/.credentials.json'],['','/fixture/home/.claude/.credentials.json']]){const requests=[];const result=await reader({platform:'linux',env:{CLAUDE_CONFIG_DIR:'/fixture/settings',CLAUDE_SECURESTORAGE_CONFIG_DIR:secure},credentials:{claudeAiOauth:{accessToken:'fixture'}},requests})();assert.equal(result.ok,true);assert.equal(requests.find(r=>r.file).file,expected);}const requests=[];await reader({env:{CLAUDE_CONFIG_DIR:'/fixture/settings',CLAUDE_SECURESTORAGE_CONFIG_DIR:''},keychain:{claudeAiOauth:{accessToken:'fixture'}},requests})();assert.ok(requests[0].includes('Claude Code-credentials'));assert.ok(!requests[0].some(x=>x.startsWith('Claude Code-credentials-')));});
