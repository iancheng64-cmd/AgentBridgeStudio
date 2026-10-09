import {EventEmitter} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import type {Client,ClientChannel} from 'ssh2';
import {appServerCommand} from './app-server-rpc';
import {claudeRemoteBootstrap} from './claude-remote-bootstrap';
import type {ClaudeTransport} from './claude-local-protocol';
import type {ClaudeApiSettings,ClaudeAuthMode} from './claude-auth-mode';
export function remoteBootstrapCommand(platform:'windows'|'posix',nodeExecutable='node'){
 // Windows OpenSSH may start through cmd.exe (8191-character limit). Keep the
 // command short and load public bridge code from the first SSH stdin line.
 const loader="let b=Buffer.alloc(0);function load(c){b=Buffer.concat([b,c]);const n=b.indexOf(10);if(n<0){if(b.length>65536)process.exit(1);return;}process.stdin.pause();process.stdin.removeListener('data',load);const rest=b.subarray(n+1);if(rest.length)process.stdin.unshift(rest);eval(Buffer.from(b.subarray(0,n).toString('ascii'),'base64').toString('utf8'));process.stdin.resume();}process.stdin.on('data',load);";
 return appServerCommand(platform,nodeExecutable,['-e',loader]);
}
export async function launchRemoteClaude(conn:Client,input:{platform:'windows'|'posix';nodeExecutable?:string;executable?:string;remoteCwd?:string;configDir?:string;args:string[];authMode:ClaudeAuthMode;api?:ClaudeApiSettings;mcpToken?:string;autoCompactPercent?:number}){
 const channel=await new Promise<ClientChannel>((resolve,reject)=>conn.exec(remoteBootstrapCommand(input.platform,input.nodeExecutable),{pty:false},(error,stream)=>error?reject(error):resolve(stream)));
 const transport=new EventEmitter() as ClaudeTransport;transport.on("error",()=>{});transport.write=line=>channel.write(line);const decoder=new StringDecoder('utf8');let buffer='',ready=false,ping:NodeJS.Timeout|undefined;
 const meta=await new Promise<any>((resolve,reject)=>{
  const timeout=setTimeout(()=>{channel.destroy();reject(new Error('朋友的 Claude 初始化逾時；請確認原生 CLI 與 Node.js。'));},40000);
  const end=()=>{clearTimeout(timeout);clearInterval(ping);if(!ready)reject(new Error('朋友的 Claude 未啟動，請確認 Node.js 與原生 Claude 執行檔路徑。'));transport.emit('close');};channel.once('close',end);channel.on('error',()=>{clearTimeout(timeout);reject(new Error('Claude SSH 通道已中斷。'));transport.emit('error',new Error('SSH closed'));});channel.stderr.on('data',()=>{});
  channel.on('data',(chunk:Buffer)=>{if(ready){transport.emit('data',chunk);return;}buffer+=decoder.write(chunk);if(buffer.length>65536){channel.destroy();clearTimeout(timeout);reject(new Error('Claude 初始化資料超過限制。'));return;}const newline=buffer.indexOf('\n');if(newline<0)return;let message;try{message=JSON.parse(buffer.slice(0,newline));}catch{clearTimeout(timeout);channel.destroy();reject(new Error('朋友的 Claude 啟動回應無效。'));return;}
   if(message.type!=='agentbridge_ready'){clearTimeout(timeout);channel.destroy();const stageNames:Record<string,string>={executable:'原生 Claude 執行檔／版本', 'cli-capabilities':'CLI 支援的功能',settings:'朋友的設定資料夾','login-directory':'Claude 登入設定目錄（需為該設備存在的完整路徑）',authentication:'朋友的登入狀態',process:'遠端程序'};reject(new Error('朋友的 Claude 初始化失敗：'+(stageNames[message.stage]||'啟動程序')+'。請在朋友主機確認。'));return;}
   ready=true;clearTimeout(timeout);buffer=buffer.slice(newline+1);ping=setInterval(()=>{if(!channel.destroyed)channel.write(JSON.stringify({type:'agentbridge_ping'})+'\n');},5000);resolve(message);
  });
  // Credentials are absent from command arguments and files: send private launch material only through encrypted stdin.
  channel.write(Buffer.from(claudeRemoteBootstrap).toString('base64')+'\n');
  channel.write(JSON.stringify({executable:input.executable,remoteCwd:input.remoteCwd,configDir:input.configDir,args:input.args,authMode:input.authMode,api:input.api,mcpToken:input.mcpToken,autoCompactPercent:input.autoCompactPercent})+'\n');
 });
 // Hold initialization trailing bytes until the protocol has installed its listeners.
 setImmediate(()=>{if(buffer)transport.emit('data',Buffer.from(buffer));});
 return{transport,version:String(meta.version||'unknown'),account:{accountKey:typeof meta.auth?.accountKey==='string'?meta.auth.accountKey:undefined,nativeAuthenticated:meta.auth?.nativeAuthenticated===true,nativeAuthMethod:String(meta.auth?.nativeAuthMethod||'unknown'),verified:meta.auth?.verified===true,authenticated:meta.auth?.authenticated===true,type:'claude-code',authMethod:String(meta.auth?.authMethod||'unknown'),apiProvider:String(meta.auth?.apiProvider||'unknown')},platform:String(meta.remotePlatform||input.platform),cwd:String(meta.remoteCwd||''),credentialDir:typeof meta.claudeCredentialDir==='string'?meta.claudeCredentialDir:undefined,configDir:typeof meta.claudeConfigDir==='string'?meta.claudeConfigDir:undefined,close:async()=>{
  clearInterval(ping);if(channel.destroyed)return;
  await new Promise<void>(resolve=>{const timeout=setTimeout(()=>{channel.destroy();resolve();},1500);channel.once('close',()=>{clearTimeout(timeout);resolve();});channel.write(JSON.stringify({type:'agentbridge_stop'})+'\n');});
 }};
}
