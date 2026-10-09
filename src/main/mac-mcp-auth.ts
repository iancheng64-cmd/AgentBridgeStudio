import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {auth,type OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import type {OAuthTokens,OAuthClientInformationMixed,OAuthClientMetadata} from '@modelcontextprotocol/sdk/shared/auth.js';

export interface MacMcpSecretCodec {available():boolean;encrypt(value:string):string;decrypt(value:string):string}
/** App-owned credentials only. Never imports another client's OAuth store. */
export class MacMcpOAuthProvider implements OAuthClientProvider {
 private verifier='';private nonce=randomUUID();
 readonly redirectUrl='http://127.0.0.1:41987/oauth/callback';
 private key:string;
 constructor(private file:string,readonly serverUrl:string,private codec:MacMcpSecretCodec,private redirect?:(url:URL)=>Promise<void>){this.key=createHash('sha256').update(serverUrl).digest('hex');}
 get clientMetadata():OAuthClientMetadata{return{client_name:'AgentBridge Studio on this Mac',redirect_uris:[this.redirectUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'};}
 state(){return this.nonce;}
 validState(value:string|null){if(!value)return false;const a=Buffer.from(value),b=Buffer.from(this.nonce);return a.length===b.length&&timingSafeEqual(a,b);}
 private read(){try{const record=JSON.parse(fs.readFileSync(this.file,'utf8'))[this.key];return record?JSON.parse(this.codec.decrypt(record)):{};}catch{return{};}}
 private save(patch:Record<string,unknown>){if(!this.codec.available())throw new Error('macOS 加密儲存不可用，未儲存 MCP 授權。');let records:Record<string,string>={};try{records=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{}records[this.key]=this.codec.encrypt(JSON.stringify({...this.read(),...patch}));fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});fs.writeFileSync(this.file+'.tmp',JSON.stringify(records),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);fs.chmodSync(this.file,0o600);}
 clientInformation():OAuthClientInformationMixed|undefined{return this.read().client;}
 saveClientInformation(client:OAuthClientInformationMixed){this.save({client});}
 tokens():OAuthTokens|undefined{return this.read().tokens;}
 saveTokens(tokens:OAuthTokens){this.save({tokens});}
 saveCodeVerifier(value:string){this.verifier=value;}
 codeVerifier(){if(!this.verifier)throw new Error('MCP 登入工作階段已結束。');return this.verifier;}
 async redirectToAuthorization(url:URL){if(!this.redirect)throw new Error('請在這台 Mac 的應用程式與外掛頁面登入 MCP。');if(url.protocol!=='https:'||url.username||url.password)throw new Error('MCP 授權網址無效。');await this.redirect(url);}
 invalidateCredentials(scope:'all'|'client'|'tokens'|'verifier'|'discovery'){if(scope==='all'||scope==='client')this.save({client:undefined});if(scope==='all'||scope==='tokens')this.save({tokens:undefined});if(scope==='all'||scope==='verifier')this.verifier='';}
}

let activeLogin:{close():void}|undefined;
export function stopMacMcpLogin(){activeLogin?.close();activeLogin=undefined;}
/** Opens the local user's browser. Consent/login remains with that user. */
export async function beginMacMcpLogin(options:{file:string;url:string;codec:MacMcpSecretCodec;open:(url:string)=>Promise<void>;notify:(message:string)=>void}){
 if(activeLogin)throw new Error('已有 MCP 登入正在進行；請先完成或稍後重試。');
 if(!options.codec.available())throw new Error('macOS 加密儲存目前不可用。');
 let opened=false,finishing=false,timer:NodeJS.Timeout|undefined;
 const provider=new MacMcpOAuthProvider(options.file,options.url,options.codec,async url=>{await options.open(url.href);opened=true;});
 const server=http.createServer((req,res)=>{void(async()=>{
  const url=new URL(req.url||'/','http://127.0.0.1:41987');
  if(req.method!=='GET'||url.pathname!=='/oauth/callback'){res.writeHead(404);res.end();return;}
  if(!provider.validState(url.searchParams.get('state'))){res.writeHead(403);res.end('Invalid login state');return;}
  const code=url.searchParams.get('code');if(finishing||!code||url.searchParams.has('error')){res.writeHead(400);res.end('Login was cancelled or already handled');if(!finishing)close();return;}
  finishing=true;
  try{const result=await auth(provider,{serverUrl:options.url,authorizationCode:code});if(result!=='AUTHORIZED')throw new Error('not authorized');res.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'"});res.end('<p>Mac MCP 登入完成。請回到 AgentBridge Studio，重新連接 Agent。</p>');options.notify('Mac MCP 登入完成，請重新連接 Agent 以載入工具。');}
  catch{res.writeHead(400);res.end('Login could not be completed. Return to AgentBridge Studio.');options.notify('Mac MCP 登入未完成，請重新嘗試。');}
  finally{close();}
 })();});
 const close=()=>{clearTimeout(timer);server.close();server.closeIdleConnections();if(activeLogin?.close===close)activeLogin=undefined;};
 await new Promise<void>((resolve,reject)=>{server.once('error',()=>reject(new Error('Mac MCP 登入通道目前無法啟動，請稍後再試。')));server.listen(41987,'127.0.0.1',resolve);});activeLogin={close};timer=setTimeout(()=>{options.notify('Mac MCP 登入已逾時，可重新登入。');close();},300000);
 try{const result=await auth(provider,{serverUrl:options.url});if(result==='AUTHORIZED'){close();return{opened:false,authenticated:true};}if(!opened)throw new Error('not opened');return{opened:true,authenticated:false};}
 catch{close();throw new Error('無法啟動 Mac MCP 登入，請確認 MCP 服務支援 OAuth 並可連線。');}
}
