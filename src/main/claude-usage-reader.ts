/** Runs exclusively on the Claude host. Only a whitelisted usage snapshot leaves it.
 * Native Claude's OAuth usage endpoint is not a versioned public API. Fail closed. */
export async function readClaudeSubscriptionUsage(configDir?:string,secureStorageDir?:string,activeOAuthToken?:string):Promise<any>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),https=require('node:https'),cp=require('node:child_process');
 const storage=secureStorageDir===undefined?process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR:secureStorageDir;
 const chosen=storage===undefined?(configDir||process.env.CLAUDE_CONFIG_DIR):storage;
 const home=(chosen||path.join(os.homedir(),'.claude')).normalize('NFC');
 const fail=(code:string)=>({ok:false,code,checkedAt:Date.now()});
 // setup-token is an inference-only credential. Do not report another stored
 // account's quota when this is the CLI's active authentication method.
 if(activeOAuthToken)return fail('OAUTH_USAGE_UNSUPPORTED');
 let stored:any;
 // Native macOS prioritizes Keychain; an old fallback file may still exist after login.
 // Namespace and account match native Claude; never scan or borrow another profile.
 if(process.platform==='darwin'){
  const suffix=chosen?'-'+require('node:crypto').createHash('sha256').update(home).digest('hex').substring(0,8):'';
  let account;try{account=process.env.USER||os.userInfo().username;}catch{return fail('KEYCHAIN_UNAVAILABLE');}
  try{stored=JSON.parse(cp.execFileSync('/usr/bin/security',['find-generic-password','-a',account,'-s','Claude Code-credentials'+suffix,'-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:10000,maxBuffer:65536}));}catch{}
 }
 if(!stored)try{stored=JSON.parse(fs.readFileSync(path.join(home,'.credentials.json'),'utf8'));}catch(e:any){return fail(e.code==='ENOENT'?(process.platform==='darwin'?'KEYCHAIN_UNAVAILABLE':'NO_OAUTH'):'CREDENTIAL_UNREADABLE');}
 const oauth=stored?.claudeAiOauth;if(typeof oauth?.accessToken!=='string'||!oauth.accessToken)return fail('NO_OAUTH');
 if(typeof oauth.expiresAt==='number'&&oauth.expiresAt<=Date.now())return fail('OAUTH_EXPIRED');
 return new Promise(resolve=>{
  const req=https.request('https://api.anthropic.com/api/oauth/usage',{headers:{Authorization:'Bearer '+oauth.accessToken,'anthropic-beta':'oauth-2025-04-20',Accept:'application/json','User-Agent':'AgentBridge-Usage/0.5.2'}},(res:any)=>{
   let body='',size=0;res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536){res.destroy();resolve(fail('USAGE_RESPONSE'));return;}body+=chunk;});res.on('error',()=>resolve(fail('USAGE_NETWORK')));
   res.on('end',()=>{
    if(res.statusCode!==200){resolve(fail(res.statusCode===401?'OAUTH_EXPIRED':res.statusCode===403?'USAGE_FORBIDDEN':res.statusCode===429?'USAGE_RATE_LIMIT':'USAGE_UNAVAILABLE'));return;}
    try{const raw=JSON.parse(body),windows:any={};for(const id of ['five_hour','seven_day','seven_day_opus','seven_day_sonnet','seven_day_oauth_apps']){const w=raw[id];if(!w||typeof w.utilization!=='number'||!Number.isFinite(w.utilization)||w.utilization<0||w.utilization>100)continue;windows[id]={utilization:w.utilization,resets_at:typeof w.resets_at==='string'?w.resets_at:null};}resolve(Object.keys(windows).length?{ok:true,windows,checkedAt:Date.now()}:fail('USAGE_RESPONSE'));}catch{resolve(fail('USAGE_RESPONSE'));}
   });
  });req.setTimeout(10000,()=>req.destroy());req.on('error',()=>resolve(fail('USAGE_NETWORK')));req.end();
 });
}
