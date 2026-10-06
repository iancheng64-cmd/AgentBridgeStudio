/** Sent as public code; the private launch payload travels separately over SSH stdin.
 * No OAuth/auth.json/keychain data is read or transported. */
export const claudeRemoteBootstrap=String.raw`
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),readline=require('node:readline');
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});let child,temporary,closing=false,lastPing=Date.now(),timer,stage='executable';
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
const provider=key=>/^ANTHROPIC_|^CLAUDE_CODE_(?:USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|OAUTH_TOKEN|SUBAGENT_MODEL|MAX_OUTPUT_TOKENS)$/.test(key);
const skip=new Set(['model','fallbackModel','apiKeyHelper','awsAuthRefresh','awsCredentialExport','forceLoginMethod','forceLoginOrgUUID','availableModels','modelOverrides']);
async function cleanup(){if(temporary)await fsp.rm(temporary,{recursive:true,force:true}).catch(()=>{});}
function kill(){if(!child||!child.pid)return;try{if(process.platform==='win32')cp.spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,timeout:5000});else process.kill(-child.pid,'SIGKILL');}catch{}}
async function shutdown(){if(closing)return;closing=true;clearInterval(timer);kill();await cleanup();process.exit(0);}
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,shutdown);lines.on('close',shutdown);
function executable(requested){if(requested&&/[\0\r\n]/.test(requested))throw Error('invalid executable');if(process.platform!=='win32')return requested||'claude';const candidates=requested?[requested]:[path.join(os.homedir(),'.local/bin/claude.exe'),path.join(os.homedir(),'.claude/local/claude.exe'),path.join(process.env.APPDATA||'', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe')];for(const file of candidates)if(fs.existsSync(file)&&fs.statSync(file).isFile()&&!/\.(cmd|bat|ps1)$/i.test(file))return file;try{const rows=cp.execFileSync('where.exe',[requested||'claude'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split(/\r?\n/);const file=rows.find(x=>/\.exe$/i.test(x));if(file)return file;}catch{}throw Error('Native Claude executable not found; set the friend host Claude .exe path.');}
function capture(exe,args,env,cwd){try{return cp.execFileSync(exe,args,{encoding:'utf8',env,cwd,timeout:15000,maxBuffer:1024*1024,stdio:['ignore','pipe','ignore'],windowsHide:true});}catch(e){return typeof e.stdout==='string'?e.stdout:'';}}
async function launch(input){
 const cwd=input.remoteCwd||os.homedir();if(!fs.statSync(cwd).isDirectory())throw Error('invalid Runtime directory');const exe=executable(input.executable),version=capture(exe,['--version'],process.env,cwd).trim().slice(0,120);if(!version)throw Error('Claude version unavailable');
 // --help omits supported internal flags (including --permission-prompt-tool).
 // The caller verifies the real stream-json initialize handshake before exposing
 // this Runtime as connected; help text is not a capability contract.
 stage='settings';
 const env={...process.env};if(input.authMode==='official')for(const key of Object.keys(env))if(provider(key))delete env[key];
 const home=process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude');const settings={};
 for(const file of [path.join(home,'settings.json'),path.join(cwd,'.claude/settings.json'),path.join(cwd,'.claude/settings.local.json')]){
  let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw Error('Native Claude settings cannot be safely loaded');}
  for(const [key,item]of Object.entries(value)){if(key==='env'){for(const [name,text]of Object.entries(item||{}))if(typeof text==='string'&&(input.authMode==='api'||!provider(name)))env[name]=text;}else if(input.authMode!=='official'||!skip.has(key))settings[key]=item;}
 }
 // Friend-host hooks can execute commands before permission callbacks. Disable them for the split execution route.
 settings.disableAllHooks=true;
 if(input.authMode==='api'&&input.api){if(input.api.baseUrl){const u=new URL(input.api.baseUrl);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||(u.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw Error('Invalid API endpoint');env.ANTHROPIC_BASE_URL=u.href.replace(/\/$/,'');for(const key of ['CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'])delete env[key];}if(input.api.apiKey){env.ANTHROPIC_API_KEY=input.api.apiKey;delete env.ANTHROPIC_AUTH_TOKEN;delete env.CLAUDE_CODE_OAUTH_TOKEN;delete settings.apiKeyHelper;}if(input.api.model){env.ANTHROPIC_MODEL=input.api.model;delete settings.model;}}
 env.AGENTBRIDGE_MAC_MCP_TOKEN=input.mcpToken;
 temporary=await fsp.mkdtemp(path.join(os.tmpdir(),'agentbridge-claude-remote-'));if(process.platform!=='win32')await fsp.chmod(temporary,0o700);
 const settingsFile=path.join(temporary,'settings.json');await fsp.writeFile(settingsFile,JSON.stringify(settings),{mode:0o600});
 const context=path.join(temporary,'native-context');await fsp.mkdir(path.join(context,'.claude-plugin'),{recursive:true});await fsp.writeFile(path.join(context,'.claude-plugin/plugin.json'),JSON.stringify({name:'agentbridge-native-context',version:'1.0.0'}),{mode:0o600});let count=0;
 for(const category of ['skills','commands','agents']){const destination=path.join(context,category);await fsp.mkdir(destination);for(const source of [path.join(home,category),path.join(cwd,'.claude',category)]){let names;try{names=await fsp.readdir(source);}catch{continue;}for(const name of names){if(name.startsWith('.'))continue;const original=path.join(source,name),target=path.join(destination,name);await fsp.rm(target,{recursive:true,force:true});const isDir=fs.statSync(original).isDirectory();try{await fsp.symlink(original,target,process.platform==='win32'?(isDir?'junction':'file'):undefined);}catch{if(isDir)continue;await fsp.copyFile(original,target);}count++;}}}
 stage='authentication';const authArgs=['--setting-sources','','--settings',settingsFile];let auth={};try{auth=JSON.parse(capture(exe,[...authArgs,'auth','status','--json'],env,cwd));}catch{}
 const args=[...authArgs,...(count?['--plugin-dir',context]:[]),...input.args,'--strict-mcp-config','--tools','AskUserQuestion,Skill,TodoWrite,WebSearch,WebFetch','--disallowedTools','Bash,Read,Write,Edit,MultiEdit,Glob,Grep,NotebookEdit,NotebookRead,Agent,Task,Computer,ComputerUse'];
 stage='process';child=cp.spawn(exe,args,{cwd,env,stdio:'pipe',detached:process.platform!=='win32',windowsHide:true});
 child.on('error',()=>{output({type:'agentbridge_error',message:'Remote Claude process failed to start'});void shutdown();});child.stderr.on('data',()=>{});
 output({type:'agentbridge_ready',version,auth:{authenticated:auth.loggedIn===true,type:'claude-code',authMethod:typeof auth.authMethod==='string'?auth.authMethod:'unknown',apiProvider:typeof auth.apiProvider==='string'?auth.apiProvider:'unknown'},remotePlatform:process.platform,remoteCwd:cwd});
 child.stdout.pipe(process.stdout);child.on('close',()=>void shutdown());timer=setInterval(()=>{if(Date.now()-lastPing>20000)void shutdown();},1000);
}
let started=false,launching=false,queued=[];
lines.on('line',line=>{if(!started){if(launching){queued.push(line);return;}launching=true;let payload;try{payload=JSON.parse(line);}catch{void shutdown();return;}launch(payload).then(()=>{started=true;for(const saved of queued)handle(saved);queued=[];}).catch(()=>{output({type:'agentbridge_error',stage});void shutdown();});return;}handle(line);});
function handle(line){let message;try{message=JSON.parse(line);}catch{void shutdown();return;}if(message.type==='agentbridge_ping'){lastPing=Date.now();return;}if(message.type==='agentbridge_stop'){void shutdown();return;}if(child&&!closing)child.stdin.write(line+'\n');}
`;
