import type { Client, ClientChannel } from 'ssh2';
import { StringDecoder } from 'node:string_decoder';

import type { RuntimePlatform } from './host-platform';
export type { RuntimePlatform } from './host-platform';
export function remoteLaunchError(platform:'windows'|'posix', message:string) {
  if (platform === 'posix' && /(?:^|[\s'"\/])bash(?:['"\s:]|$)/i.test(message)) {
    return new Error('主機無法執行 bash。請將「主機系統」改為自動辨識；Windows 設備也可選擇 Windows。macOS／Linux 請確認已安裝 bash。');
  }
  if (message.includes('\uFFFD')) return new Error('遠端啟動失敗，主機回傳的文字編碼無法辨識。請使用自動辨識主機系統，並確認執行檔可由 SSH 執行。');
  return new Error(message || '無法啟動遠端 Runtime，請確認主機系統與執行檔路徑。');
}
export function captureRemote(conn:Client, command:string, timeoutMs=12000):Promise<string> {
  return new Promise((resolve,reject)=>{
    let stream:ClientChannel|undefined,output='',stderr='',settled=false;
    const outDecoder=new StringDecoder('utf8'),errDecoder=new StringDecoder('utf8');
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(output);};
    const timer=setTimeout(()=>{finish(new Error('遠端預檢逾時，請確認主機在線且執行檔可由 SSH 執行。'));stream?.close();},timeoutMs);
    conn.exec(command,{pty:false},(error,channel)=>{
      if(settled){channel?.close();return;}
      if(error){finish(error);return;}stream=channel;
      channel.on('data',(chunk:Buffer)=>{output=(output+outDecoder.write(chunk)).slice(-64000);});
      channel.stderr.on('data',(chunk:Buffer)=>{stderr=(stderr+errDecoder.write(chunk)).slice(-2000);});
      channel.on('error',(error:Error)=>finish(error));
      channel.on('close',(code:number)=>{output+=outDecoder.end();stderr+=errDecoder.end();finish(code===0?undefined:new Error(stderr.trim()||'遠端命令無法執行。'));});
      channel.end();
    });
  });
}
/** Call only after SSH host identity verification and authentication succeed. */
export async function resolveRemotePlatform(conn:Client, platform:RuntimePlatform):Promise<'windows'|'posix'> {
  if(platform==='windows'||platform==='posix')return platform;
  try { if(/^(Darwin|Linux|FreeBSD|OpenBSD|NetBSD|SunOS)\b/m.test(await captureRemote(conn,'uname -s',8000)))return 'posix'; } catch {}
  const script="$ErrorActionPreference='Stop'; if([Environment]::OSVersion.Platform -eq 'Win32NT'){[Console]::WriteLine('AGENTBRIDGE_WINDOWS')}else{exit 1}";
  const command=`powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script,'utf16le').toString('base64')}`;
  try { if((await captureRemote(conn,command,8000)).trim()==='AGENTBRIDGE_WINDOWS')return 'windows'; } catch {}
  throw new Error('無法自動辨識這台設備的主機系統。請選擇 Windows 或 macOS／Linux／WSL 後重新連線。');
}
