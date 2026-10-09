/** Read only the selected Windows user's persisted Claude directory settings.
 * SSH services may retain an environment from before the interactive login. */
export function nativeClaudeDirectoryEnv(base:NodeJS.ProcessEnv){
 const env={...base};if(process.platform!=='win32')return env;
 const cp=require('node:child_process');
 const keys=['CLAUDE_CONFIG_DIR','CLAUDE_SECURESTORAGE_CONFIG_DIR'];
 try{
  const script="$result=@{};foreach($name in @('CLAUDE_CONFIG_DIR','CLAUDE_SECURESTORAGE_CONFIG_DIR')){$value=[Environment]::GetEnvironmentVariable($name,'User');if($null -eq $value){$value=[Environment]::GetEnvironmentVariable($name,'Machine')};if($null -ne $value){$result[$name]=$value}};$result|ConvertTo-Json -Compress";
  const raw=JSON.parse(cp.execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',env:base,timeout:5000,maxBuffer:16384,stdio:['ignore','pipe','ignore'],windowsHide:true}));
  for(const key of keys)if(env[key]===undefined&&typeof raw[key]==='string'&&raw[key].length<=4096&&!/[\0\r\n]/.test(raw[key]))env[key]=raw[key];
 }catch{/* Native inherited environment remains authoritative if the registry is unavailable. */}
 return env;
}
export function resolveNativeRemoteClaude(requested?:string){
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
 if(requested&&/[\0\r\n]/.test(requested))throw Error('invalid executable');
 if(process.platform!=='win32'){
  if(requested&&requested!=='claude')return requested;
  for(const file of [path.join(os.homedir(),'.local/bin/claude'),path.join(os.homedir(),'.claude/local/claude'),'/opt/homebrew/bin/claude','/usr/local/bin/claude',...(process.env.PATH||'').split(path.delimiter).filter(Boolean).map((dir:string)=>path.join(dir,'claude'))]){
   try{if(fs.statSync(file).isFile()){fs.accessSync(file,fs.constants.X_OK);return file;}}catch{}
  }
  return 'claude';
 }
 const candidates=requested?[requested]:[path.join(os.homedir(),'.local/bin/claude.exe'),path.join(os.homedir(),'.claude/local/claude.exe'),path.join(process.env.APPDATA||'','npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe')];
 for(const file of candidates)if(fs.existsSync(file)&&fs.statSync(file).isFile()&&!/\.(cmd|bat|ps1)$/i.test(file))return file;
 try{const rows=cp.execFileSync('where.exe',[requested||'claude'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split(/\r?\n/);const file=rows.find((x:string)=>/\.exe$/i.test(x));if(file)return file;}catch{}
 throw Error('Native Claude executable not found; set the friend host Claude .exe path.');
}
