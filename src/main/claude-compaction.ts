/** Enable the native switch when explicitly disabled. Preserve every other key. */
export function enableNativeAutoCompact(configDir?:string){
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const directory=configDir===undefined?process.env.CLAUDE_CONFIG_DIR:configDir;
 const file=directory?path.join(directory,'.claude.json'):path.join(os.homedir(),'.claude.json');
 let value:any;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e:any){if(e.code==='ENOENT')return;throw Error('原生 Claude 設定無法讀取，未覆寫。');}
 if(value.autoCompactEnabled!==false)return;
 const temporary=file+'.agentbridge-'+process.pid;try{fs.writeFileSync(temporary,JSON.stringify({...value,autoCompactEnabled:true}),{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
}
