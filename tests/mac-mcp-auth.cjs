const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {MacMcpOAuthProvider,beginMacMcpLogin,stopMacMcpLogin}=require('../dist-main/mac-mcp-auth');

const serverUrl='https://mcp.oauth-fixture.invalid/mcp';
const authHost='auth.oauth-fixture.invalid';

function makeCodec(enabled=true){
 return{
  available:()=>enabled,
  encrypt:value=>'fixture-cipher:'+Buffer.from(value,'utf8').toString('base64'),
  decrypt:value=>{assert.ok(value.startsWith('fixture-cipher:'));return Buffer.from(value.slice('fixture-cipher:'.length),'base64').toString('utf8');}
 };
}

function oauthFetch({failToken=false}={}){
 return async(input,init={})=>{
  const url=input instanceof URL?input:new URL(typeof input==='string'?input:input.url);
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  if(url.hostname==='mcp.oauth-fixture.invalid'&&url.pathname.includes('oauth-protected-resource')){
   return json({resource:serverUrl,authorization_servers:['https://'+authHost],scopes_supported:['mcp:tools']});
  }
  if(url.hostname===authHost&&url.pathname.includes('oauth-authorization-server')){
   return json({issuer:'https://'+authHost,authorization_endpoint:'https://'+authHost+'/authorize',token_endpoint:'https://'+authHost+'/token',registration_endpoint:'https://'+authHost+'/register',response_types_supported:['code'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']});
  }
  if(url.hostname===authHost&&url.pathname==='/register'){
   assert.equal(init.method,'POST');
   const registration=JSON.parse(init.body);
   return json({client_id:'fixture-client-id',client_secret:'fixture-client-secret',token_endpoint_auth_method:'none',redirect_uris:registration.redirect_uris});
  }
  if(url.hostname===authHost&&url.pathname==='/token'){
   assert.equal(init.method,'POST');
   if(failToken)return json({error:'server_error',error_description:'fixture-private-token-error'},500);
   return json({access_token:'fixture-access-token-secret',refresh_token:'fixture-refresh-token-secret',token_type:'Bearer',expires_in:3600});
  }
  throw new Error('Unexpected synthetic OAuth request: '+url.href);
 };
}

async function callbackPortAvailable(){
 const probe=http.createServer();
 try{
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(41987,'127.0.0.1',resolve);});
  await new Promise(resolve=>probe.close(resolve));
  return true;
 }catch{probe.close();return false;}
}

test('state validation rejects missing and mismatched values',()=>{
 const provider=new MacMcpOAuthProvider('/tmp/unused-mac-mcp-auth.json',serverUrl,makeCodec());
 const state=provider.state();
 assert.ok(provider.validState(state));
 assert.equal(provider.validState(null),false);
 assert.equal(provider.validState('wrong-state'),false);
 assert.equal(provider.validState(state+'x'),false);
});

test('credential records are encrypted and isolated by exact server URL',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mac-mcp-auth-store-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'mac-mcp-auth.json'),codec=makeCodec();
 const a=new MacMcpOAuthProvider(file,'https://service-a.fixture/mcp',codec);
 const b=new MacMcpOAuthProvider(file,'https://service-b.fixture/mcp',codec);
 a.saveClientInformation({client_id:'fixture-client-a',client_secret:'fixture-client-secret-a'});
 a.saveTokens({access_token:'fixture-access-a-secret',refresh_token:'fixture-refresh-a-secret',token_type:'Bearer'});
 assert.equal(a.clientInformation().client_id,'fixture-client-a');
 assert.equal(a.tokens().refresh_token,'fixture-refresh-a-secret');
 assert.equal(b.clientInformation(),undefined);
 assert.equal(b.tokens(),undefined);
 b.saveTokens({access_token:'fixture-access-b-secret',refresh_token:'fixture-refresh-b-secret',token_type:'Bearer'});
 assert.equal(b.tokens().access_token,'fixture-access-b-secret');
 const raw=fs.readFileSync(file,'utf8'),records=JSON.parse(raw);
 assert.equal(Object.keys(records).length,2);
 assert.ok(Object.values(records).every(record=>record.startsWith('fixture-cipher:')));
 for(const secret of ['fixture-client-a','fixture-client-secret-a','fixture-access-a-secret','fixture-refresh-a-secret','fixture-access-b-secret','fixture-refresh-b-secret'])assert.ok(!raw.includes(secret));
 if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
});

test('OAuth callback enforces state, stores only cipher text, and sanitizes token errors', {timeout:15000}, async t=>{
 if(!(await callbackPortAvailable())){t.skip('固定 loopback OAuth callback port 41987 is already in use');return;}
 const originalFetch=globalThis.fetch,root=fs.mkdtempSync(path.join(os.tmpdir(),'mac-mcp-auth-callback-'));
 t.after(()=>{stopMacMcpLogin();globalThis.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});});
 globalThis.fetch=oauthFetch();
 const file=path.join(root,'auth.json'),codec=makeCodec();let openedUrl='';const notices=[];
 const started=await beginMacMcpLogin({file,url:serverUrl,codec,open:async value=>{openedUrl=value;},notify:value=>notices.push(value)});
 assert.deepEqual(started,{opened:true,authenticated:false});
 const authorize=new URL(openedUrl),state=authorize.searchParams.get('state');
 assert.equal(authorize.protocol,'https:');assert.ok(state);
 const originalHttpFetch=originalFetch;
 const rejected=await originalHttpFetch('http://127.0.0.1:41987/oauth/callback?state=wrong-state&code=fixture-code');
 assert.equal(rejected.status,403);
 assert.match(await rejected.text(),/Invalid login state/);
 const callback=await originalHttpFetch('http://127.0.0.1:41987/oauth/callback?state='+encodeURIComponent(state)+'&code=fixture-oauth-code');
 assert.equal(callback.status,200);
 assert.match(await callback.text(),/登入完成/);
 const provider=new MacMcpOAuthProvider(file,serverUrl,codec);
 assert.equal(provider.tokens().access_token,'fixture-access-token-secret');
 const raw=fs.readFileSync(file,'utf8'),records=JSON.parse(raw);
 assert.ok(Object.values(records).every(record=>record.startsWith('fixture-cipher:')));
 for(const secret of ['fixture-client-id','fixture-client-secret','fixture-access-token-secret','fixture-refresh-token-secret','fixture-oauth-code','fixture-private-token-error'])assert.ok(!raw.includes(secret));
 if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
 stopMacMcpLogin();

 globalThis.fetch=oauthFetch({failToken:true});openedUrl='';
 const retry=await beginMacMcpLogin({file,url:serverUrl,codec,open:async value=>{openedUrl=value;},notify:value=>notices.push(value)});
 assert.deepEqual(retry,{opened:true,authenticated:false});
 const retryState=new URL(openedUrl).searchParams.get('state');
 const failed=await originalHttpFetch('http://127.0.0.1:41987/oauth/callback?state='+encodeURIComponent(retryState)+'&code=fixture-oauth-code');
 assert.equal(failed.status,400);
 const body=await failed.text();
 assert.doesNotMatch(body,/fixture-private-token-error|fixture-oauth-code/);
 assert.ok(notices.some(message=>message==='Mac MCP 登入未完成，請重新嘗試。'));
 assert.ok(notices.every(message=>!message.includes('fixture-private-token-error')));
 stopMacMcpLogin();
});

test('unavailable secure storage refuses login and token persistence',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mac-mcp-auth-unavailable-'));
 try{
  const file=path.join(root,'auth.json'),codec=makeCodec(false),provider=new MacMcpOAuthProvider(file,serverUrl,codec);let opened=false;
  assert.throws(()=>provider.saveTokens({access_token:'fixture-secret',token_type:'Bearer'}),/加密儲存不可用/);
  await assert.rejects(beginMacMcpLogin({file,url:serverUrl,codec,open:async()=>{opened=true;},notify:()=>{}}),/加密儲存目前不可用/);
  assert.equal(opened,false);
  assert.equal(fs.existsSync(file),false);
 }finally{stopMacMcpLogin();fs.rmSync(root,{recursive:true,force:true});}
});
