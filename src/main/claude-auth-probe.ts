/** Native auth metadata only. Failed probes are unknown, never a fabricated logout. */
export function readNativeClaudeAuthStatus(executable:string,args:string[],env:NodeJS.ProcessEnv,cwd:string){
 const cp=require('node:child_process');
 let stdout='';
 try{stdout=cp.execFileSync(executable,[...args,'auth','status','--json'],{encoding:'utf8',env,cwd,timeout:15000,maxBuffer:65536,stdio:['ignore','pipe','ignore'],windowsHide:true});}
 catch(e:any){stdout=typeof e.stdout==='string'?e.stdout:'';}
 try{const value=JSON.parse(stdout);if(typeof value.loggedIn!=='boolean')throw Error('unknown shape');return{accountKey:typeof value.email==='string'?require('node:crypto').createHash('sha256').update(value.email+'|'+String(value.organizationUuid||'')).digest('hex'):undefined,authenticated:value.loggedIn,verified:true,type:'claude-code',authMethod:typeof value.authMethod==='string'?value.authMethod:'unknown',apiProvider:typeof value.apiProvider==='string'?value.apiProvider:'unknown'};}
 catch{return{authenticated:false,verified:false,type:'claude-code',authMethod:'unavailable',apiProvider:'unknown'};}
}
