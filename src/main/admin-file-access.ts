import {execFile} from 'node:child_process';
import path from 'node:path';
import type {AdminReadAction} from './admin-file-worker';
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
const appleString=(value:string)=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n').replaceAll('\r','\\r')+'"';
export function adminReadScript(action:AdminReadAction,target:string,executable=process.execPath){
 if(!['list','stat','read'].includes(action)||!path.isAbsolute(target)||target.includes('\0'))throw new Error('Administrator read request is invalid');
 const encoded=Buffer.from(target).toString('base64');
 // A clean environment blocks NODE_OPTIONS and other user-level injection into root.
 const command=['/usr/bin/env','-i','ELECTRON_RUN_AS_NODE=1',quote(executable),quote(path.join(__dirname,'admin-file-worker.js')),quote(action),quote(encoded)].join(' ');
 return 'do shell script '+appleString(command)+' with administrator privileges';
}
let pending=false;
export async function administratorRead(action:AdminReadAction,target:string,signal?:AbortSignal):Promise<unknown>{
 if(process.platform!=='darwin')throw new Error('Administrator reads require macOS');
 if(pending)throw new Error('Administrator authorization is already pending');
 if(signal?.aborted)throw new Error('Request cancelled');
 const script=adminReadScript(action,target);pending=true;
 try{
  const output=await new Promise<string>((resolve,reject)=>execFile('/usr/bin/osascript',['-e',script],{encoding:'utf8',signal,timeout:110000,maxBuffer:8*1024*1024},(error,stdout)=>{if(error){reject(new Error(signal?.aborted?'Request cancelled':'Administrator authorization cancelled or unsuccessful'));return;}resolve(stdout);}));
  if(signal?.aborted)throw new Error('Request cancelled');
  const response=JSON.parse(output);
  if(response.error)throw new Error(response.error==='EPERM'?'macOS privacy or system protection denied access; Full Disk Access is separate from root':response.error==='EACCES'?'Administrator read denied by filesystem permissions':response.error==='ENOENT'?'Administrator path does not exist':'Administrator file read failed');
  return response.result;
 }finally{pending=false;}
}
