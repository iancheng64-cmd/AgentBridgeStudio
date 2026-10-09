import fs from 'node:fs/promises';
import path from 'node:path';
export type AdminReadAction='list'|'stat'|'read';
/** Fixed read-only worker: no shell command, executable or write action comes from a model. */
export async function readAdminFile(action:AdminReadAction,target:string){
 if(!['list','stat','read'].includes(action)||!path.isAbsolute(target)||target.includes('\0'))throw new Error('INVALID_REQUEST');
 if(action==='list'){const entries=await fs.readdir(target,{withFileTypes:true});return{entries:entries.slice(0,1000).map(entry=>({name:entry.name,type:entry.isSymbolicLink()?'symlink':entry.isDirectory()?'directory':'file'})),truncated:entries.length>1000,administrator:true};}
 const stat=await fs.stat(target);
 if(action==='stat')return{type:stat.isDirectory()?'directory':stat.isFile()?'file':'other',size:stat.size,modifiedAt:stat.mtime.toISOString(),administrator:true};
 const file=await fs.open(target,'r');try{if(!(await file.stat()).isFile())throw new Error('NOT_REGULAR_FILE');const data=Buffer.alloc(1024*1024+1);const{bytesRead}=await file.read(data,0,data.length,0);return{text:data.subarray(0,Math.min(bytesRead,1024*1024)).toString('utf8'),truncated:bytesRead>1024*1024,administrator:true};}finally{await file.close();}
}
if(require.main===module){
 const action=process.argv[2] as AdminReadAction,target=Buffer.from(process.argv[3]||'','base64').toString('utf8');
 if(process.getuid?.()!==0){process.stdout.write(JSON.stringify({error:'NOT_ADMINISTRATOR'}));process.exitCode=1;}
 else void readAdminFile(action,target).then(result=>process.stdout.write(JSON.stringify({result})),error=>{process.stdout.write(JSON.stringify({error:['EACCES','EPERM','ENOENT','ENOTDIR'].includes(error.code)?error.code:'READ_FAILED'}));});
}
