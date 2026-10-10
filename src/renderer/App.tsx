import {useComposerDrafts} from './useComposerDrafts';
import {useChatHistory} from './useChatHistory';
import {chatToMarkdown,sanitizeFilename} from './export-markdown';
import {branchChat,findInConversation,EXCERPT_RADIUS} from './chat-utilities';
import {StreamTextBatcher,messageWindow} from '../main/chat-performance';
import {flushSync} from 'react-dom';
import {NetworkSettings} from './NetworkSettings';
import {RelayFiles,RelayTerminal} from './RelayViews';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MotionConfig, motion, useTransform } from 'framer-motion';
import { ConnectionForm, FilesView, ComputerView, ExtensionsView, SettingsView, TerminalPane, formatBytes, type Profile, type SessionInfo, type Address, type Agent } from './LegacyViews';
import { Glyph, Modal, MessageBody } from './StudioUI';
import { RuntimeStatus, RuntimePendingRequest, RuntimeReadinessNotice, runtimeReadiness, reasoningOptions, type RuntimeConnection, type RuntimeRequest } from './RuntimeControls';
import { AttachmentVisual } from './AttachmentPreview';
import { MacToolsPanel } from './MacToolsPanel';
import { UsagePage } from './UsagePage';
import {QuotaPopover} from './QuotaPopover';
import {useCodexQuota} from './useCodexQuota';
import { ClaudeSettings } from './ClaudeSettings';
import { updateUsage, type UsageRecord } from '../main/runtime-usage';
import {continuationContext} from '../main/runtime-errors';
import { ConnectionSelection } from '../main/connection-selection';
import {profileRuntimePlatform, connectionPlatformIdentity, type RuntimePlatform} from '../main/host-platform';
import type { DoctorReport } from './global';
import { SIDEBAR_MAX, SIDEBAR_MIN, SidebarResizer, useSidebarWidth } from './SidebarDrag';

type Page = 'chat'|'library'|'apps'|'computer'|'terminal'|'remote'|'history'|'project'|'usage';
type Setting = 'general'|'connection'|'data'|'shortcuts'|'advanced'|'about';
interface Attachment { id:string; name:string; localPath:string; size:number; addedAt:number; mimeType?:string; remotePath?:string; }
interface ToolActivity { itemId:string; tool:string; title:string; status:'running'|'completed'|'error'; executionLocation?:'local'|'remote'; durationMs?:number; }
interface Message { id:string; role:'user'|'assistant'; text:string; compactions?:{at:number;preTokens:number|null;postTokens:number|null;trigger:string}[]; attachments?:Attachment[]; tools?:ToolActivity[]; status?:'running'|'completed'|'cancelled'|'error'; }
interface Chat { executorEnvironmentId?:string; recoveryNeeded?:boolean; transport?:'runtime'|'ssh'|'orchestrator'; localCwd?:string; model?:string; id:string; title:string; messages:Message[]; createdAt:number; updatedAt:number; agent:Agent; remoteId?:string; hostId?:string; hostKey?:string; pinned?:boolean; archived?:boolean; projectId?:string; temporary?:boolean; bookmarks?:string[]; }
interface Project { id:string; name:string; }
interface Extension { id:string; name:string; kind:'skill'|'plugin'|'mcp'; source:'local'|'remote'; agent:string; status:string; description?:string; }
const read = <T,>(key:string,fallback:T):T => { try { const value=JSON.parse(localStorage.getItem(key)||'null'); if(value===null)return fallback; if(Array.isArray(fallback))return Array.isArray(value)?value as T:fallback; if(typeof value!==typeof fallback)return fallback; if(key==='studio.theme'&&!['light','dark','system'].includes(value))return fallback; if(key==='studio.agent'&&!['codex','claude'].includes(value))return fallback; return value; } catch { return fallback; } };
const readAgentPreferences=(key:string):Partial<Record<Agent,string>>=>{try{const value=JSON.parse(localStorage.getItem(key)||'null');if(!value||typeof value!=='object'||Array.isArray(value))return {};return Object.fromEntries(['codex','claude'].filter(agent=>typeof value[agent]==='string'&&value[agent].length<=256).map(agent=>[agent,value[agent]]));}catch{return {};}};
const validAttachment=(file:any):file is Attachment=>file&&typeof file.id==='string'&&typeof file.name==='string'&&typeof file.localPath==='string'&&typeof file.size==='number';
const normalizeChats=(values:any[]):Chat[]=>values.filter(chat=>chat&&typeof chat.id==='string'&&typeof chat.title==='string'&&Array.isArray(chat.messages)).map(chat=>({...chat,agent:chat.agent==='claude'?'claude':'codex',createdAt:Number(chat.createdAt)||Date.now(),updatedAt:Number(chat.updatedAt)||Date.now(),temporary:chat.temporary===true,bookmarks:Array.isArray(chat.bookmarks)?chat.bookmarks.filter((id:any)=>typeof id==='string'):[],messages:chat.messages.filter((message:any)=>message&&typeof message.id==='string'&&typeof message.text==='string'&&['user','assistant'].includes(message.role)).map((message:any)=>({...message,status:message.status==='running'?'cancelled':message.status,tools:Array.isArray(message.tools)?message.tools.filter((tool:any)=>tool&&typeof tool.itemId==='string'&&typeof tool.title==='string').map((tool:any)=>({...tool,status:tool.status==='running'?'error':tool.status})):[],attachments:Array.isArray(message.attachments)?message.attachments.filter(validAttachment):[]}))}));
const readChats=():Chat[]=>{const raw=localStorage.getItem('studio.chats');if(raw===null)return [];const values=JSON.parse(raw);if(!Array.isArray(values)||values.some(chat=>!chat||typeof chat.id!=='string'||typeof chat.title!=='string'||!Array.isArray(chat.messages)||chat.messages.some((message:any)=>!message||typeof message.id!=='string'||typeof message.text!=='string'||!['user','assistant'].includes(message.role))))throw new Error('原有對話格式無法讀取。');return normalizeChats(values);};
const hostKey=(profile:Profile)=>profile.networkMode==='relay'?`relay:${profile.id}:${profile.relayUrl}`:`${profile.username}@${profile.host.toLowerCase()}:${profile.port||22}`;
const api = () => window.agentBridge as any;
const dateLabel = (timestamp:number) => new Date(timestamp).toLocaleDateString('zh-TW',{month:'short',day:'numeric'});
const newProfile = () => ({id:crypto.randomUUID(),name:'新的設備',host:'',port:22,username:'',authType:'agent',keyPath:'',password:'',savePassword:true,runtimePlatform:'auto',claudeConfigDir:''});

function App() {
  const [page,setPage] = useState<Page>('chat');
  const [sidebar,setSidebar] = useState(()=>read('studio.sidebar',true));
  const [sidebarWidth,setSidebarWidth] = useState(()=>{const stored=read('studio.sidebarWidth',260);return Number.isFinite(stored)?Math.min(SIDEBAR_MAX,Math.max(SIDEBAR_MIN,stored)):260;});
  const { width:sidebarWidthMotion, isDragging:sidebarDragging, handlers:sidebarHandlers } = useSidebarWidth(sidebarWidth,!sidebar,setSidebarWidth);
  // A motion value written to a custom property comes out unitless, and a bare
  // number is not a valid length — `grid-template-columns` would reject it and
  // collapse the whole layout to a single column. Add the unit here.
  const sidebarWidthCss=useTransform(sidebarWidthMotion,(value)=>`${value}px`);
  const [theme,setTheme] = useState<'light'|'dark'|'system'>(()=>read('studio.theme','system'));
  const [systemDark,setSystemDark] = useState(()=>matchMedia('(prefers-color-scheme: dark)').matches);
  const [reduceMotion,setReduceMotion] = useState(()=>read('studio.reduceMotion',false));
  const [agent,setAgent] = useState<Agent>(()=>read('studio.agent','codex'));
  const [chats,setChats] = useState<Chat[]>([]);
  const streamText=useRef<StreamTextBatcher|null>(null);
  if(!streamText.current)streamText.current=new StreamTextBatcher(updates=>{
    const grouped=new Map<string,Map<string,typeof updates[number]>>();for(const update of updates){if(!grouped.has(update.chatId))grouped.set(update.chatId,new Map());grouped.get(update.chatId)!.set(update.messageId,update);}
    setChats(previous=>previous.map(chat=>{const changes=grouped.get(chat.id);if(!changes)return chat;return {...chat,updatedAt:Date.now(),messages:chat.messages.map(message=>{const change=changes.get(message.id);return change?{...message,text:change.replace?change.text:message.text+change.text}:message;})};}));
  });
  const [projects,setProjects] = useState<Project[]>(()=>read<any[]>('studio.projects',[]).filter(project=>project&&typeof project.id==='string'&&typeof project.name==='string'));
  const [historyEnd,setHistoryEnd]=useState<number|null>(null);
  const [currentId,setCurrentId] = useState<string|null>(null);
  const [projectId,setProjectId] = useState<string|null>(null);

  const [library,setLibrary] = useState<Attachment[]>([]);
  const [fileSearch,setFileSearch] = useState('');
  const [libraryMode,setLibraryMode] = useState<'grid'|'list'>('grid');
  const [extensions,setExtensions] = useState<Extension[]>([]);
  const [extensionWarnings,setExtensionWarnings] = useState<string[]>([]);
  const [extensionTab,setExtensionTab] = useState<'all'|'plugin'|'mcp'|'skill'>('all');
  const [extensionSearch,setExtensionSearch] = useState('');
  const [extensionLimit,setExtensionLimit] = useState(60);
  const [loadingExtensions,setLoadingExtensions] = useState(false);
  const [extensionManager,setExtensionManager] = useState(false);
  const [profiles,setProfiles] = useState<Profile[]>([]);
  const [profilesLoaded,setProfilesLoaded]=useState(false);
  // Old versions connected at launch and could block history behind a Keychain prompt.
  // Automatic credential access now requires a fresh, explicit opt-in.
  const [autoConnect,setAutoConnect]=useState(()=>read('studio.autoConnectOnLaunch',false));
  const connectionSelection=useRef(new ConnectionSelection());
  const [session,setSession] = useState<SessionInfo|null>(null);
  const [draft,setDraft] = useState<any>(newProfile);
  const [connecting,setConnecting] = useState(false);
  const [connectionError,setConnectionError]=useState<string|null>(null);
  const [connectionMode,setConnectionMode] = useState<'runtime'|'ssh'>('runtime');
  const [connections,setConnections] = useState<Partial<Record<Agent,RuntimeConnection>>>({});
  const connectionsRef=useRef(connections);connectionsRef.current=connections;
  const runtime=connections[agent]||null;
  const setRuntime=(value:RuntimeConnection|null)=>setConnections(previous=>{const next={...previous};if(value)next[value.agent||agent]=value;else delete next[agent];return next;});
  const engineApi=(provider:Agent=agent)=>provider==='claude'?api().claude:api().runtime;
  const runtimeRef=useRef(runtime);runtimeRef.current=runtime;
  const [runtimePlatform,setRuntimePlatform] = useState<RuntimePlatform>('auto');
  const selectRuntimePlatform=(value:RuntimePlatform)=>{setRuntimePlatform(value);setDraft((previous:any)=>({...previous,runtimePlatform:value}));setConnectionError(null);};
  const [runtimeExecutable,setRuntimeExecutable] = useState(()=>read('studio.runtimeExecutable','codex'));
  const [localCwd,setLocalCwd] = useState(()=>read('studio.localCwd',''));
  const [modelsByAgent,setModelsByAgent]=useState<Partial<Record<Agent,string>>>(()=>readAgentPreferences('studio.models'));
  const [effortsByAgent,setEffortsByAgent]=useState<Partial<Record<Agent,string>>>(()=>readAgentPreferences('studio.efforts'));
  const runtimeModel=modelsByAgent[agent]||'';
  const runtimeEffort=effortsByAgent[agent]||'';
  const setRuntimeModel=(value:string)=>setModelsByAgent(previous=>({...previous,[agent]:value}));
  const setRuntimeEffort=(value:string)=>setEffortsByAgent(previous=>({...previous,[agent]:value}));
  const [claudeExecutable,setClaudeExecutable]=useState(()=>read('studio.friendClaudeExecutable',''));

  const [claudeAuthMode,setClaudeAuthMode]=useState<'official'|'api'>(()=>read('studio.claudeAuthMode','official'));
  const [claudeNodeExecutable,setClaudeNodeExecutable]=useState(()=>read('studio.claudeNodeExecutable','node'));
  const [claudeRemoteCwd,setClaudeRemoteCwd]=useState(()=>read('studio.claudeRemoteCwd',''));
  const [claudeBaseUrl,setClaudeBaseUrl]=useState('');
  const [claudeApiKey,setClaudeApiKey]=useState('');
  const [claudeApiModel,setClaudeApiModel]=useState('');
  const [claudeAutoCompactPercent,setClaudeAutoCompactPercent]=useState<number>(()=>{const value=Number(read('studio.claudeAutoCompactPercent',70));return [60,70,80,95].includes(value)?value:70;});
  const [codexAutoCompactPercent,setCodexAutoCompactPercent]=useState<number>(()=>{const value=Number(read('studio.codexAutoCompactPercent',70));return [60,70,80,95].includes(value)?value:70;});
  const [customModel,setCustomModel]=useState('');
  const [usageRecords,setUsageRecords]=useState<UsageRecord[]>(()=>read<UsageRecord[]>('studio.usage',[]).filter(record=>record&&typeof record.requestId==='string'&&typeof record.startedAt==='number'&&['codex','claude'].includes(record.agent)).map(record=>({...record,status:record.status==='running'?'interrupted':record.status})));
  const [claudeQuota,setClaudeQuota]=useState<any>();
  const [claudeQuotaBusy,setClaudeQuotaBusy]=useState(false),[recovering,setRecovering]=useState(false);
  const recoveryAttempt=useRef(0),manualDisconnect=useRef(false),autoConnectRef=useRef(autoConnect);autoConnectRef.current=autoConnect;
  const refreshClaudeQuota=useCallback(async(recheck=false)=>{const active=connectionsRef.current.claude;if(!active)return;setClaudeQuotaBusy(true);try{if(recheck){const snapshot=await api().claude.status(active.runtimeId);if(connectionsRef.current.claude?.runtimeId!==active.runtimeId)return;setConnections(previous=>({...previous,claude:{...active,...snapshot,hostName:active.hostName,hostKey:active.hostKey}}));}const result=await api().claude.quota(active.runtimeId);if(connectionsRef.current.claude?.runtimeId===active.runtimeId)setClaudeQuota(result);}catch{if(connectionsRef.current.claude?.runtimeId===active.runtimeId)setClaudeQuota((previous:any)=>({...previous,updatedAt:previous?.updatedAt||0,windows:previous?.windows||[],status:'unavailable',stale:true,error:'Claude 額度查詢通道已中斷。請重新連線後更新；未提供不代表零。'}));}finally{if(connectionsRef.current.claude?.runtimeId===active.runtimeId)setClaudeQuotaBusy(false);}},[]);
  useEffect(()=>{setClaudeQuota(undefined);setClaudeQuotaBusy(false);if(!connections.claude)return;void refreshClaudeQuota();const timer=setInterval(()=>{void refreshClaudeQuota();},120000);return()=>clearInterval(timer);},[connections.claude?.runtimeId,refreshClaudeQuota]);

  const {quota,baseline:quotaBaseline,busy:quotaBusy,refresh:refreshQuota,receive:acceptQuota}=useCodexQuota(connections.codex?.runtimeId,connections.codex?.account.authenticated===true,id=>api().runtime.usage(id));
  useEffect(()=>{try{localStorage.setItem('studio.usage',JSON.stringify(usageRecords));localStorage.setItem('studio.claudeAuthMode',JSON.stringify(claudeAuthMode));}catch{setToast('使用紀錄儲存失敗，請匯出報告。');}},[usageRecords,claudeAuthMode]);
  const [runtimeBusy,setRuntimeBusy] = useState(false);
  const sendPending=useRef(false);
  const [permissionMode,setPermissionMode] = useState<'ask'|'project'|'full'>(()=>{const saved=read('studio.permissionMode','project');return ['ask','project','full'].includes(saved)?saved as 'ask'|'project'|'full':'project';});
  // This stays in memory only; credentials must never be logged or persisted.
  const connectionSignature=JSON.stringify([agent,autoConnect,connectionMode,draft.id,draft.networkMode,draft.relayUrl,draft.host,draft.port,draft.username,draft.authType,draft.keyPath,draft.password,draft.hasSavedPassword,localCwd,runtimePlatform,permissionMode,agent==='claude'?[claudeExecutable,claudeNodeExecutable,claudeRemoteCwd,draft.claudeConfigDir,claudeAuthMode,claudeBaseUrl,claudeApiKey,claudeApiModel,claudeAutoCompactPercent]:[runtimeExecutable,codexAutoCompactPercent]]);
  connectionSelection.current.select(connectionSignature);
  const [importing,setImporting] = useState(false);
  const [toolResults,setToolResults] = useState<Record<string,{text?:string;image?:string}>>({});
  const [runtimeRequests,setRuntimeRequests] = useState<RuntimeRequest[]>([]);
  const [hostConfirmation,setHostConfirmation] = useState<{hostFingerprint:string;previousFingerprint?:string;hostChanged:boolean;payload:any}|null>(null);
  const [services,setServices] = useState<any[]>([]);
  const [addresses,setAddresses] = useState<Address[]>([]);
  const [doctor,setDoctor] = useState<DoctorReport|null>(null);
  const [settings,setSettings] = useState<Setting|null>(null);
  const [searchOpen,setSearchOpen] = useState(false);
  const [search,setSearch] = useState('');
  const [historyMode,setHistoryMode] = useState<'active'|'archived'>('active');
  const [chatSearch,setChatSearch]=useState<string|null>(null);
  const [chatSearchIndex,setChatSearchIndex]=useState(0);
  const [editMessage,setEditMessage]=useState<{chatId:string;messageId:string;text:string}|null>(null);
  const [templateModal,setTemplateModal]=useState(false);
  const [templates,setTemplates]=useState<{id:string;title:string;body:string}[]>(()=>read<any[]>('studio.templates',[]).filter(item=>item&&typeof item.id==='string'&&typeof item.title==='string'&&typeof item.body==='string'));
  const insertTemplate=(body:string)=>{setInput(input?`${input.trim()}\n\n${body}`:body);setTemplateModal(false);composerRef.current?.focus();};
  const saveTemplate=(title:string,body:string)=>{const trimmed=title.trim();if(!trimmed||!body.trim()){notify('範本需要標題與內容。');return;}setTemplates(prev=>[{id:crypto.randomUUID(),title:trimmed.slice(0,60),body:body.trim()},...prev]);notify('已加入提示範本');};
  const [customInstructions,setCustomInstructions]=useState<string>(()=>read('studio.customInstructions',''));
  const [ttsEnabled,setTtsEnabled]=useState<boolean>(()=>read('studio.ttsEnabled',false));
  const [desktopNotifications,setDesktopNotifications]=useState<boolean>(()=>read('studio.desktopNotifications',false));
  const ttsActive=useRef<string|null>(null);
  const [attachMenu,setAttachMenu] = useState(false);
  const [modelMenu,setModelMenu] = useState(false);
  const [commandMenu,setCommandMenu] = useState(false);
  const [collabMode,setCollabMode] = useState(false);
  const [collabRounds,setCollabRounds] = useState(3);
  const [chatMenu,setChatMenu] = useState<string|null>(null);
  const [rename,setRename] = useState<{kind:'chat'|'project';id:string;value:string}|null>(null);
  const [deleteChat,setDeleteChat] = useState<string|null>(null);
  const [projectModal,setProjectModal] = useState(false);
  const [projectName,setProjectName] = useState('');
  const [picker,setPicker] = useState(false);
  const [toast,setToast] = useState<string|null>(null);
  const [dragging,setDragging] = useState(false);
  const [working,setWorking] = useState<{requestId:string;chatId:string;messageId:string;activity:string;sessionId:string;transport?:'runtime'|'ssh'|'orchestrator';agent?:Agent}|null>(null);
  const workingRef = useRef(working); workingRef.current=working;
  const [terminalKey,setTerminalKey] = useState(0);
  const composerRef=useRef<HTMLTextAreaElement>(null);
  const messageEnd=useRef<HTMLDivElement>(null);
  const followBottom=useRef(true);
  const [showScrollDown,setShowScrollDown]=useState(false);
  const [scrolling,setScrolling]=useState(false);
  const scrollIdle=useRef<number|null>(null);
  // A fade where content meets the floating toolbar, shown only while content
  // is actually moving under it. A permanent 1px rule would be a divider;
  // this is an edge effect, so it belongs to the moment of scrolling.
  const markScrolling=useCallback(()=>{
    setScrolling(true);
    if(scrollIdle.current)window.clearTimeout(scrollIdle.current);
    scrollIdle.current=window.setTimeout(()=>setScrolling(false),520);
  },[]);
  useEffect(()=>()=>{if(scrollIdle.current)window.clearTimeout(scrollIdle.current);},[]);
  const dragDepth=useRef(0);
  const current=chats.find(chat=>chat.id===currentId);
  const currentProject=projects.find(project=>project.id===projectId);
  const notify=useCallback((message:string)=>setToast(message),[]);
  const error=useCallback((e:unknown)=>notify(e instanceof Error?e.message:String(e)),[notify]);
  const safe=useCallback((work:()=>Promise<unknown>)=>{void work().catch(error);},[error]);
  const composer=useComposerDrafts<Attachment>(currentId?'chat:'+currentId:'new:'+agent,validAttachment,notify);
  const {text:input,setText:setInput,attachments,setAttachments}=composer;
  const historyReady=useChatHistory(chats,setChats,readChats,normalizeChats,notify,()=>flushSync(()=>streamText.current?.flush()),composer.flush);
  const visibleMessages=messageWindow(current?.messages.length||0,historyEnd);
  useEffect(()=>setHistoryEnd(null),[currentId]);
  const refreshLibrary=useCallback(async()=>{ if(api()?.library) setLibrary(await api().library.list()); },[]);
  const refreshExtensions=useCallback(async()=>{
    if(!api()?.extensions) return;
    setLoadingExtensions(true);
    try { const active=connectionsRef.current[agent];const result=active&&engineApi().extensions?await engineApi().extensions(active.runtimeId):await api().extensions.list(session?.sessionId); setExtensions(result.items); setExtensionWarnings(result.warnings); } catch(e){error(e);} finally {setLoadingExtensions(false);}
  },[session?.sessionId,agent,runtime?.runtimeId,error]);
  const selectPermission=(mode:'ask'|'project'|'full')=>safe(async()=>{
    const updates=await Promise.all(Object.entries(connectionsRef.current).map(async([provider,active])=>({...active,...await engineApi(provider as Agent).permission(active!.runtimeId,mode),agent:provider})));
    setPermissionMode(mode);setConnections(previous=>{const next={...previous};for(const updated of updates)if(next[updated.agent as Agent]?.runtimeId===updated.runtimeId)next[updated.agent as Agent]=updated;return next;});
  });
  const localRefreshSequence=useRef(0);
  const [toolHealth,setToolHealth]=useState<string|null>(null);
  const [computerProvider,setComputerProvider]=useState<any>(null);
  const [httpExposure,setHttpExposure]=useState<any>(null);
  const [toolsBusy,setToolsBusy]=useState(false);
  const [httpHealth,setHttpHealth]=useState<string|null>(null);
  const [permissionDiagnostics,setPermissionDiagnostics]=useState<string|null>(null);
  const [standaloneTools,setStandaloneTools]=useState<RuntimeConnection['macTools']|null>(null);
  const refreshLocal=useCallback(async()=>{
    const sequence=++localRefreshSequence.current;const active=runtimeRef.current;
    const result=await Promise.allSettled([api().local.network(),api().services.status(),api().local.doctor(active?{runtimeId:active.runtimeId,provider:active.agent||'codex'}:undefined),api().local.computerProvider(),api().exposure.get()]);
    if(sequence!==localRefreshSequence.current||runtimeRef.current?.runtimeId!==active?.runtimeId)return;
    if(result[0].status==='fulfilled')setAddresses(result[0].value);
    if(result[1].status==='fulfilled')setServices(result[1].value);
    if(result[2].status==='fulfilled')setDoctor(result[2].value);
    if(result[3].status==='fulfilled')setComputerProvider(result[3].value);
    if(result[4].status==='fulfilled')setHttpExposure(result[4].value);
  },[]);
  useEffect(()=>{setToolHealth(null);setDoctor(null);if(runtime&&api()){setStandaloneTools(null);safe(()=>api().local.stopToolHealth());}if(api())safe(refreshLocal);const focus=()=>safe(refreshLocal);window.addEventListener('focus',focus);return()=>window.removeEventListener('focus',focus);},[runtime?.runtimeId,agent,page,settings,refreshLocal,safe]);
  const checkToolHealth=(reset=false)=>safe(async()=>{
    const active=runtimeRef.current;setToolHealth('正在檢查這台 Mac 的工具…');
    try{const result=await api().local.toolHealth(active?{runtimeId:active.runtimeId,provider:active.agent||'codex'}:{reset});if(runtimeRef.current?.runtimeId===active?.runtimeId){setStandaloneTools(active?null:result?.macTools||null);setToolHealth(result?.browser?.ok?'原生電腦工具已回應；瀏覽器分頁讀取成功。macOS 權限請見下方。':'工具未回報健康狀態。');}}
    catch(e){if(runtimeRef.current?.runtimeId===active?.runtimeId){setStandaloneTools(null);setToolHealth(e instanceof Error?e.message:String(e));}}await refreshLocal();
  });
  const chooseComputerProvider=(provider:'bundled'|'open-computer-use')=>safe(async()=>{
    setToolsBusy(true);try{const selected=await api().local.selectComputerProvider(provider);setComputerProvider(selected);setStandaloneTools(null);setToolHealth(null);setPermissionDiagnostics(null);setHttpHealth(null);await refreshLocal();}finally{setToolsBusy(false);}
  });
  const httpToolAction=(name:'computer'|'browser',action:'start'|'stop'|'health')=>safe(async()=>{
    setToolsBusy(true);setHttpHealth(null);try{const result=await api().services[action](name);setHttpHealth(action==='stop'?'HTTP 工具已停止。':`${name==='computer'?'電腦':'瀏覽器'} HTTP 已接通 · ${result.health.source} · ${result.health.toolCount} 個工具 · ${result.health.probe} 讀取成功。`);}catch(e){setHttpHealth(e instanceof Error?e.message:String(e));throw e;}finally{await refreshLocal();setToolsBusy(false);}
  });
  const recoverTools=()=>{const active=runtimeRef.current;if(!active){checkToolHealth(true);return;}safe(async()=>{const result=await engineApi(active.agent||'codex').recoverTools(active.runtimeId);if(runtimeRef.current?.runtimeId===active.runtimeId)setRuntime(result);await refreshLocal();});};
  useEffect(()=>{ for(const [key,value] of Object.entries({'studio.models':modelsByAgent,'studio.efforts':effortsByAgent,'studio.projects':projects,'studio.theme':theme,'studio.reduceMotion':reduceMotion,'studio.agent':agent,'studio.sidebar':sidebar,'studio.sidebarWidth':sidebarWidth,'studio.runtimePlatform':runtimePlatform,'studio.runtimeExecutable':runtimeExecutable,'studio.localCwd':localCwd,'studio.permissionMode':permissionMode,'studio.autoConnectOnLaunch':autoConnect,'studio.friendClaudeExecutable':claudeExecutable,'studio.claudeNodeExecutable':claudeNodeExecutable,'studio.claudeRemoteCwd':claudeRemoteCwd,'studio.claudeAutoCompactPercent':claudeAutoCompactPercent,'studio.codexAutoCompactPercent':codexAutoCompactPercent,'studio.customInstructions':customInstructions,'studio.ttsEnabled':ttsEnabled,'studio.desktopNotifications':desktopNotifications,'studio.templates':templates})) { try{localStorage.setItem(key,JSON.stringify(value));}catch{notify('本機儲存空間不足，請匯出對話以保留內容。');} } },[modelsByAgent,effortsByAgent,projects,theme,reduceMotion,agent,sidebar,sidebarWidth,runtimePlatform,runtimeExecutable,localCwd,claudeExecutable,claudeNodeExecutable,claudeRemoteCwd,claudeAutoCompactPercent,codexAutoCompactPercent,autoConnect,permissionMode,customInstructions,ttsEnabled,desktopNotifications,templates,notify]);
  useEffect(()=>{const media=matchMedia('(prefers-color-scheme: dark)');const listener=()=>setSystemDark(media.matches);media.addEventListener('change',listener);return()=>media.removeEventListener('change',listener);},[]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),5000);return()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{
    if(!api()) return;
    safe(async()=>{const saved:Profile[]=await api().profiles.list();setProfiles(saved);const preferred=read('studio.lastProfileId','');const chosen=saved.find(profile=>profile.id===preferred)||saved.find(profile=>profile.hasSavedPassword)||saved[0];if(chosen){setDraft({...chosen,password:''});setRuntimePlatform(profileRuntimePlatform(chosen));}setProfilesLoaded(true);}); safe(refreshLocal);safe(refreshLibrary);
    const offService=api().services.onEvent((event:any)=>setServices(prev=>{
      const existing=prev.find(item=>item.name===event.name);
      return [...prev.filter(item=>item.name!==event.name),{...existing,...event,
        health:event.status==='running'?(event.health||existing?.health):undefined}];
    }));
    const offToast=api().onToast((event:any)=>notify(event.message));
    const offClosed=api().ssh.onClosed?.((event:any)=>{
      setSession(previous=>previous?.sessionId===event.sessionId?null:previous);
      streamText.current?.flush();const active=workingRef.current;
      if(active&&active.sessionId===event.sessionId){setChats(previous=>previous.map(chat=>chat.id===active.chatId?{...chat,messages:chat.messages.map(message=>message.id===active.messageId?{...message,status:'error',text:message.text||'遠端連線已中斷。請重新連線後重試。'}:message)}:chat));workingRef.current=null;setWorking(null);}
    });
    const offChat=api().chat?.onEvent((event:any)=>{
      const work=workingRef.current;if(!work||work.requestId!==event.requestId)return;
      if(!['message','delta','activity'].includes(event.type))streamText.current?.flush();
      if(event.type==='session')setChats(prev=>prev.map(chat=>chat.id===work.chatId?{...chat,remoteId:event.conversationId}:chat));
      if(event.type==='message'||event.type==='delta')streamText.current!.push({chatId:work.chatId,messageId:work.messageId,text:event.text||'',replace:event.type==='message'});
      if(event.type==='activity')setWorking(prev=>prev?{...prev,activity:event.text||'正在處理…'}:null);
      if(event.type==='error')setChats(prev=>prev.map(chat=>chat.id===work.chatId?{...chat,messages:chat.messages.map(message=>message.id===work.messageId?{...message,text:message.text?message.text+'\n\n'+event.text:event.text||'執行失敗，請檢查遠端 Agent 是否已登入。',status:'error'}:message)}:chat));
      if(event.type==='done'){
        setChats(prev=>prev.map(chat=>chat.id===work.chatId?{...chat,messages:chat.messages.map(message=>message.id===work.messageId?{...message,tools:message.tools?.map(tool=>tool.status==='running'?{...tool,status:event.status==='completed'?'completed':'error'}:tool),status:message.status==='error'?'error':event.status==='cancelled'?'cancelled':event.status==='error'?'error':'completed'}:message)}:chat));
        setWorking(null);workingRef.current=null;
        notifyDesktop(event.status==='cancelled'?'Agent 已停止':'Agent 已完成回覆');
        if(ttsEnabled&&event.status!=='cancelled')speakMessage(work.chatId,work.messageId);
      }
    });
    const offOrchestrator=api().orchestrator?.onEvent((event:any)=>{
      const work=workingRef.current;
      if(!work||work.transport!=='orchestrator'||work.requestId!==event.runId)return;
      const append=(block:string,status?:Message['status'])=>setChats(previous=>previous.map(chat=>chat.id===work.chatId?{...chat,updatedAt:Date.now(),messages:chat.messages.map(message=>message.id===work.messageId?{...message,text:[message.text,block].filter(Boolean).join('\n\n---\n\n'),...(status?{status}:{} )}:message)}:chat));
      if(event.type==='activity'){setWorking(previous=>previous?{...previous,activity:event.text||'Codex 與 Claude 正在討論…'}:null);return;}
      if(event.type==='turn'){
        const speaker=event.agent==='claude'?'Claude':'Codex';
        append(`### 第 ${event.round} 輪 · ${speaker}\n\n${event.text||''}`);return;
      }
      if(event.type==='final'){append(`## 綜合結論\n\n${event.text||''}`);return;}
      if(event.type==='error'){append(`## 討論中斷\n\n${event.text||'自動討論發生錯誤。'}`,'error');return;}
      if(event.type==='done'){
        setChats(previous=>previous.map(chat=>chat.id===work.chatId?{...chat,updatedAt:Date.now(),messages:chat.messages.map(message=>message.id===work.messageId?{...message,status:message.status==='error'?'error':event.status==='cancelled'?'cancelled':event.status==='error'?'error':'completed'}:message)}:chat));
        workingRef.current=null;setWorking(null);
        notifyDesktop(event.status==='cancelled'?'Agent 已停止':'Agent 已完成回覆');
        if(ttsEnabled&&event.status!=='cancelled')speakMessage(work.chatId,work.messageId);
      }
    });
    const handleRuntimeEvent=(event:any)=>{
      if(event.type==='claudeQuota'){if(connectionsRef.current.claude?.runtimeId===event.runtimeId)setClaudeQuota(event.quota);return;}
      if(event.type==='quota'){acceptQuota(event.runtimeId,event.quota);return;}
      if(event.type==='usage'&&event.requestId){setUsageRecords(previous=>updateUsage(previous,event.requestId,event.usage));return;}
      if(event.type==='done'&&event.requestId)setUsageRecords(previous=>previous.map(record=>record.requestId===event.requestId?{...record,finishedAt:Date.now(),status:event.status==='completed'?'completed':event.status==='cancelled'?'cancelled':'error'}:record));
      if(event.type==='status'){
        const provider:Agent=event.agent==='claude'?'claude':'codex';const active=connectionsRef.current[provider];
        if(active&&active.runtimeId===event.runtimeId&&event.snapshot){const updated={...active,...event.snapshot,agent:provider,hostName:active.hostName,hostKey:active.hostKey};setConnections(previous=>({...previous,[provider]:updated}));if(runtimeRef.current?.runtimeId===event.runtimeId)runtimeRef.current=updated;}
        return;
      }
      if(event.type==='closed'){
        streamText.current?.flush();
        if(runtimeRef.current?.runtimeId===event.runtimeId&&!manualDisconnect.current&&autoConnectRef.current&&!runtimeRef.current?.requiresReconnectKey&&!/ERR_AUTH|IDENTITY|TLS|CREDENTIAL/i.test(event.text||'')){recoveryAttempt.current=0;setRecovering(true);}
        setConnections(previous=>Object.fromEntries(Object.entries(previous).filter(([,value])=>value?.runtimeId!==event.runtimeId)));if(runtimeRef.current?.runtimeId===event.runtimeId){runtimeRef.current=null;notify(event.text||'Agent 連線已中斷。');}
        setRuntimeRequests(previous=>previous.filter(request=>request.runtimeId!==event.runtimeId));
        const active=workingRef.current;
        if(active?.transport==='runtime'&&active.sessionId===event.runtimeId){setChats(previous=>previous.map(chat=>chat.id===active.chatId?{...chat,messages:chat.messages.map(message=>message.id===active.messageId?{...message,tools:message.tools?.map(tool=>tool.status==='running'?{...tool,status:'error'}:tool),status:'error',text:message.text||'Runtime 連線已中斷。請重新連線後重試。'}:message)}:chat));workingRef.current=null;setWorking(null);}
        return;
      }
      if(event.type==='requestClosed'){setRuntimeRequests(previous=>previous.filter(request=>request.approvalId!==event.approvalId));return;}
      if(event.type==='approval'||event.type==='userInput'){
        if(!Object.values(connectionsRef.current).some(value=>value?.runtimeId===event.runtimeId))return;
        setRuntimeRequests(previous=>[...previous.filter(request=>request.approvalId!==event.approvalId),event]);
        setWorking(previous=>previous&&previous.sessionId===event.runtimeId?{...previous,activity:event.type==='userInput'?'等待你的回答':'等待你的核准'}:previous);return;
      }
      const work=workingRef.current;if(!work||work.transport!=='runtime'||work.sessionId!==event.runtimeId||work.requestId!==event.requestId)return;
      if(!['message','delta','activity'].includes(event.type))streamText.current?.flush();
      if(event.type==='contextCompacted'){setChats(previous=>previous.map(chat=>chat.id===work.chatId?{...chat,messages:chat.messages.map(message=>message.id===work.messageId?{...message,compactions:[...(message.compactions||[]),{at:Date.now(),preTokens:event.preTokens??null,postTokens:event.postTokens??null,trigger:event.trigger||'auto'}]}:message)}:chat));return;}
      if(event.type==='sessionUnavailable'){setChats(previous=>previous.map(chat=>chat.id===work.chatId&&chat.remoteId===event.conversationId?{...chat,remoteId:undefined,recoveryNeeded:true}:chat));return;}
      if(event.type==='session')setChats(previous=>previous.map(chat=>chat.id===work.chatId?{...chat,remoteId:event.conversationId,...(event.executorEnvironmentId?{executorEnvironmentId:event.executorEnvironmentId}:{}),recoveryNeeded:false}:chat));
      if(event.type==='message'||event.type==='delta')streamText.current!.push({chatId:work.chatId,messageId:work.messageId,text:event.text||'',replace:event.type==='message'});
      if(event.type==='activity')setWorking(previous=>previous?{...previous,activity:event.text||'正在處理…'}:null);
      if(event.type==='tool'){
        setChats(previous=>previous.map(chat=>chat.id===work.chatId?{...chat,messages:chat.messages.map(message=>message.id===work.messageId?{...message,tools:[...(message.tools||[]).filter(tool=>tool.itemId!==event.itemId),{itemId:String(event.itemId),tool:String(event.tool||message.tools?.find(tool=>tool.itemId===event.itemId)?.tool||''),title:String(event.title||event.tool||message.tools?.find(tool=>tool.itemId===event.itemId)?.title||'使用工具'),status:event.status==='completed'?'completed':event.status==='error'?'error':'running',executionLocation:event.executionLocation,durationMs:event.durationMs}]}:message)}:chat));
        if(event.image||event.text)setToolResults(previous=>({...previous,[String(event.itemId)]:{text:typeof event.text==='string'?event.text:undefined,image:typeof event.image==='string'&&/^data:image\/(png|jpeg|gif|webp);base64,/.test(event.image)?event.image:undefined}}));
      }
      if(event.type==='error'){
        const errText=event.text||'Runtime 回覆失敗。';
        setChats(previous=>previous.map(chat=>chat.id===work.chatId?{...chat,messages:chat.messages.map(message=>message.id===work.messageId?{...message,text:message.text?`${message.text}\n\n${errText}`:errText,status:'error'}:message)}:chat));
      }
      if(event.type==='done'){
        setChats(previous=>previous.map(chat=>chat.id===work.chatId?{
          ...chat,
          ...(typeof event.conversationId==='string'?{remoteId:event.conversationId,recoveryNeeded:false}:{}),
          messages:chat.messages.map(message=>{
            if(message.id!==work.messageId)return message;
            const finalStatus=message.status==='error'?'error':event.status==='cancelled'?'cancelled':event.status==='error'?'error':'completed';
            let finalText=message.text;
            if(finalStatus==='error'&&!finalText.trim()){
              finalText=event.text||event.error||'Runtime 回報執行失敗，但未提供具體原因。原有紀錄已保留。';
            }
            return {
              ...message,
              tools:message.tools?.map(tool=>tool.status==='running'?{...tool,status:event.status==='completed'?'completed':'error'}:tool),
              status:finalStatus,
              text:finalText
            };
          })
        }:chat));
        setRuntimeRequests(previous=>previous.filter(request=>request.requestId!==event.requestId));
        setWorking(null);
        workingRef.current=null;
        notifyDesktop(event.status==='cancelled'?'Agent 已停止':'Agent 已完成回覆');
        if(ttsEnabled&&event.status!=='cancelled')speakMessage(work.chatId,work.messageId);
      }
    };
    const offRuntime=api().runtime?.onEvent((event:any)=>handleRuntimeEvent({...event,agent:'codex'}));
    const offClaude=api().claude?.onEvent((event:any)=>handleRuntimeEvent({...event,agent:'claude'}));
    return()=>{streamText.current?.flush();offService();offToast();offChat?.();offClosed?.();offOrchestrator?.();offRuntime?.();offClaude?.();};
  },[refreshLocal,refreshLibrary,safe,notify,acceptQuota]);
  useEffect(()=>{if(page==='apps')void refreshExtensions();},[page,refreshExtensions]);
  useEffect(()=>setExtensionLimit(60),[extensionSearch,extensionTab]);
  useEffect(()=>{const handler=(event:PromiseRejectionEvent)=>{event.preventDefault();error(event.reason);};window.addEventListener('unhandledrejection',handler);return()=>window.removeEventListener('unhandledrejection',handler);},[error]);
  useEffect(()=>{if(followBottom.current)messageEnd.current?.scrollIntoView({behavior:'instant'});},[current?.messages,working?.activity,historyEnd]);
  useEffect(()=>{followBottom.current=true;setShowScrollDown(false);requestAnimationFrame(()=>messageEnd.current?.scrollIntoView({behavior:'instant'}));},[currentId]);
  useEffect(()=>{if(composerRef.current){if(input.length>8000){composerRef.current.style.height='180px';}else{composerRef.current.style.height='auto';composerRef.current.style.height=Math.min(composerRef.current.scrollHeight,180)+'px';}}},[input]);
  const startNew=useCallback(()=>{setCurrentId(null);setPage('chat');setAttachMenu(false);requestAnimationFrame(()=>composerRef.current?.focus());},[]);
  const openChat=(chat:Chat)=>{if(workingRef.current&&chat.agent!==agent){notify('請先停止目前工作，再切換 Agent。');return;}setCurrentId(chat.id);setAgent(chat.agent);setProjectId(chat.projectId||null);setPage('chat');setSearchOpen(false);setChatMenu(null);};
  const openSettings=(section:Setting='general')=>{setSettings(section);setModelMenu(false);};
  // ponytail: A/B helpers (find/branch/temp/new window) are declared further down;
  // the keydown listener resolves them through this ref so declaration order can't break it.
  const hotkeys=useRef<{openChatSearch:()=>void;openNewWindow:()=>void;startTemporary:()=>void}>({openChatSearch:()=>{},openNewWindow:()=>{},startTemporary:()=>{}});
  useEffect(()=>{
    const listener=(event:KeyboardEvent)=>{
      if(!(event.metaKey||event.ctrlKey))return;
      if(event.key==='k'){event.preventDefault();setSearchOpen(true);}
      if(event.key==='n'&&event.shiftKey){event.preventDefault();startNew();}
      if(event.key===','){event.preventDefault();setSettings('general');}
      if(event.key==='b'){event.preventDefault();setSidebar(value=>!value);}
      if(event.key==='f'){event.preventDefault();hotkeys.current.openChatSearch();}
      if(event.key==='u'&&!event.shiftKey){event.preventDefault();hotkeys.current.openNewWindow();}
      if(event.key==='t'&&!event.shiftKey){event.preventDefault();hotkeys.current.startTemporary();}
      if(event.key==='u'&&event.shiftKey){event.preventDefault();setTemplateModal(true);}
    };
    window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener);
  },[startNew]);
  useEffect(()=>{const dismiss=(event:MouseEvent)=>{if(!(event.target as HTMLElement).closest('.popover-anchor,.context-anchor')){setAttachMenu(false);setModelMenu(false);setChatMenu(null);}};document.addEventListener('click',dismiss);return()=>document.removeEventListener('click',dismiss);},[]);
  const chooseFiles=async(asAttachment=true)=>{
    if(!api()?.library){notify('請使用桌面 App 開啟檔案選擇器。');return;}
    const chosen:Attachment[]=await api().library.choose();await refreshLibrary();
    if(asAttachment)setAttachments(prev=>[...prev,...chosen.filter(file=>!prev.some(item=>item.id===file.id))]);
    else if(chosen.length)notify(`已加入 ${chosen.length} 個檔案`);
    setAttachMenu(false);
  };
  const handleDrop=async(event:React.DragEvent)=>{
    event.preventDefault();dragDepth.current=0;setDragging(false);
    const paths=Array.from(event.dataTransfer.files).map(file=>api().files.pathForFile(file)).filter(Boolean);
    if(!paths.length)return;
    const added:Attachment[]=await api().library.addPaths(paths);await refreshLibrary();
    if(page==='chat')setAttachments(prev=>[...prev,...added.filter(file=>!prev.some(item=>item.id===file.id))]);else notify(`已加入 ${added.length} 個檔案到檔案庫`);
  };
  const handlePaste=async(event:React.ClipboardEvent<HTMLTextAreaElement>)=>{
    const images=Array.from(event.clipboardData.items).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>Boolean(file));
    if(!images.length)return;
    event.preventDefault();setImporting(true);
    try{
      const added:Attachment[]=[];
      for(const file of images){
        if(file.size>20*1024*1024)throw new Error('貼上的圖片上限為 20 MB。');
        const dataUrl=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('無法讀取貼上的圖片。'));reader.onload=()=>resolve(String(reader.result));reader.readAsDataURL(file);});
        added.push(...await api().library.addImage(dataUrl));
      }
      setAttachments(previous=>[...previous,...added]);await refreshLibrary();notify(`已加入 ${added.length} 張圖片`);
    }catch(e){error(e);}finally{setImporting(false);}
  };
  const connect=async()=>{
    setConnecting(true);
    try { if(session)await api().ssh.disconnect(session.sessionId);const result=await api().ssh.connect({profile:draft,password:draft.password});setSession({...result,profile:{...draft,password:undefined}});setSettings(null);notify('SSH 已連線，可使用遠端檔案與終端機。'); }
    catch(e){setSession(null);error(e);}finally{setConnecting(false);}
  };
  const applyRuntime=(result:RuntimeConnection,hostName:string,hostIdentity:string)=>{
    const provider=result.agent||agent;
    const connected={...result,agent:provider,hostName,hostKey:hostIdentity};setRuntime(connected);if(provider===agent)runtimeRef.current=connected;if(provider==='claude'&&(result as any).quota)setClaudeQuota((result as any).quota);
    const selected=result.models.find(model=>model.id===modelsByAgent[provider])||result.models.find(model=>model.isDefault)||result.models[0];
    setModelsByAgent(previous=>({...previous,[provider]:selected?.id||''}));setEffortsByAgent(previous=>({...previous,[provider]:reasoningOptions(selected).includes(previous[provider]||'')?previous[provider]:selected?.defaultReasoningEffort||''}));
  };
  const connectRuntime=async(confirmed?:any,quiet=false)=>{
    if(confirmed?.provider==='claude'||agent==='claude'){await connectClaude(confirmed,quiet);return;}
    if(workingRef.current){notify('請先中斷目前回覆，再切換 Runtime。');return;}
    if(!api().runtime){notify('Runtime 連線服務尚未載入，請重新啟動更新後的 App。');return;}
    if(!confirmed&&!localCwd.trim()){notify('請先選擇這台 Mac 的工作資料夾，再連線。');return;}
    const payload=confirmed||{profile:{...draft,runtimePlatform},password:draft.password,platform:runtimePlatform,executable:runtimeExecutable.trim()||'codex',localCwd:localCwd.trim(),permissionMode,autoCompactPercent:codexAutoCompactPercent};
    if(!quiet){manualDisconnect.current=false;setRecovering(false);}
    const attempt=connectionSelection.current.begin();
    setConnectionError(null);setConnecting(true);
    try{
      const previous=connectionsRef.current.codex;
      if(previous){await api().runtime.disconnect(previous.runtimeId);setConnections(current=>{const next={...current};if(next.codex?.runtimeId===previous.runtimeId)delete next.codex;return next;});}
      if(!confirmed&&!quiet)setProfiles(await api().profiles.save(payload.profile));
      if(!connectionSelection.current.isCurrent(attempt))return;
      try{localStorage.setItem('studio.lastProfileId',JSON.stringify(payload.profile.id));}catch{}
      const result=await api().runtime.connect(payload);
      if(!connectionSelection.current.isCurrent(attempt)){if(result.runtimeId)await api().runtime.disconnect(result.runtimeId);return;}
      if(result.status==='host-confirmation'){setSettings(null);setHostConfirmation({...result,payload});return;}
      setRecovering(false);applyRuntime(result,payload.profile.name||payload.profile.host,hostKey(payload.profile)+'|'+connectionPlatformIdentity(payload.platform,result.connectionPlatform||result.runtimePlatform));
      setHostConfirmation(null);if(!quiet)setSettings('connection');
      notify(result.capabilities.localTools?'Runtime 與 Mac 工具通道已連線。':'Runtime 已連線；請查看 Mac 工具通道狀態。');
    }catch(e){if(connectionSelection.current.isCurrent(attempt)){setConnectionError(e instanceof Error?e.message:String(e));if(/ERR_AUTH|HOST_IDENTITY|RELAY_TLS|IDENTITY|未配對|無法識別|版本|登入/i.test(String(e)))setRecovering(false);setHostConfirmation(null);if(quiet)setSettings('connection');error(e);}}finally{setConnecting(false);}
  };
  const connectClaude=async(confirmed?:any,quiet=false)=>{
    if(workingRef.current){notify('請先停止目前工作。');return;}
    if(!localCwd.trim()){setSettings('connection');notify('請先選擇這台 Mac 的工作資料夾。');return;}
    if(!quiet){manualDisconnect.current=false;setRecovering(false);}
    const attempt=connectionSelection.current.begin();
    setConnectionError(null);setConnecting(true);
    try{
      const previous=connectionsRef.current.claude;if(previous){await api().claude.disconnect(previous.runtimeId);setConnections(current=>{const next={...current};if(next.claude?.runtimeId===previous.runtimeId)delete next.claude;return next;});}
      const payload=confirmed||{provider:'claude',location:'remote',profile:{...draft,runtimePlatform},password:draft.password,platform:runtimePlatform,localCwd:localCwd.trim(),remoteCwd:claudeRemoteCwd.trim()||undefined,configDir:draft.claudeConfigDir?.trim()||undefined,nodeExecutable:claudeNodeExecutable.trim()||'node',executable:claudeExecutable.trim()||undefined,permissionMode,authMode:claudeAuthMode,autoCompactPercent:claudeAutoCompactPercent,...(claudeAuthMode==='api'?{api:{baseUrl:claudeBaseUrl.trim()||undefined,apiKey:claudeApiKey||undefined,model:claudeApiModel.trim()||undefined}}:{})};
      if(!confirmed&&!quiet)setProfiles(await api().profiles.save(payload.profile));
      if(!connectionSelection.current.isCurrent(attempt))return;
      try{localStorage.setItem('studio.lastProfileId',JSON.stringify(payload.profile.id));}catch{}
      const result=await api().claude.connect(payload);
      if(!connectionSelection.current.isCurrent(attempt)){if(result.runtimeId)await api().claude.disconnect(result.runtimeId);return;}
      if(result.status==='host-confirmation'){setSettings(null);setHostConfirmation({...result,payload});return;}
      setClaudeApiKey('');setHostConfirmation(null);setRecovering(false);
      applyRuntime({...result,agent:'claude'},payload.profile.name||payload.profile.host,hostKey(payload.profile)+`|claude|${payload.authMode}|${payload.remoteCwd||''}`+(payload.configDir?'|config:'+payload.configDir:''));if(!quiet)setSettings('connection');
      notify(result.account?.authenticated?'Claude Code 已就緒，直接在對話中交代工作。':'Runtime 已連線；尚未確認目前設定環境的 Claude 登入，請檢查登入設定資料夾。');
    }catch(e){if(connectionSelection.current.isCurrent(attempt)){setConnectionError(e instanceof Error?e.message:String(e));if(/ERR_AUTH|HOST_IDENTITY|RELAY_TLS|IDENTITY|未配對|無法識別|版本|登入/i.test(String(e)))setRecovering(false);setHostConfirmation(null);if(quiet)setSettings('connection');error(e);}}finally{setConnecting(false);}
  };
  const refreshRuntime=async()=>{
    const active=runtimeRef.current;if(!active)return;setRuntimeBusy(true);
    try{const result=await engineApi(active.agent||'codex').status(active.runtimeId);if(connectionsRef.current[active.agent||'codex']?.runtimeId!==active.runtimeId)return;applyRuntime(result,active.hostName||'Codex Runtime',active.hostKey||'');}finally{setRuntimeBusy(false);}
  };
  const cancelWork=async()=>{const active=workingRef.current;if(!active)return;if(active.transport==='orchestrator')await api().orchestrator.cancel(active.requestId);else if(active.transport==='runtime')await engineApi(active.agent||'codex').cancel(active.sessionId,active.requestId);else await api().chat.cancel(active.requestId);};
  const interruptAndSend=async()=>{const prompt=input.trim();const files=attachments;if(!prompt&&!files.length)return;if(!workingRef.current){safe(()=>send());return;}if(!historyReady||!composer.ready||sendPending.current||importing){notify('正在讀取本機對話，請稍候。');return;}const workingChatId=workingRef.current.chatId;sendPending.current=true;try{await cancelWork();let attempts=0;while(workingRef.current&&attempts++<50){await new Promise(resolve=>setTimeout(resolve,100));}if(workingRef.current){notify('無法停止目前工作，請稍後再試。');return;}if(currentId!==workingChatId){notify('已停止工作。切換對話後請重新傳送。');return;}setInput('');setAttachments([]);await send(prompt,files);}finally{sendPending.current=false;}};
  const respondToRuntime=async(request:RuntimeRequest,decision:'accept'|'decline',answers?:Record<string,string[]>)=>{
    await engineApi(Object.values(connectionsRef.current).find(value=>value?.runtimeId===request.runtimeId)?.agent||'codex').respond({runtimeId:request.runtimeId,approvalId:request.approvalId,decision,answers});
    setRuntimeRequests(previous=>previous.filter(item=>item.approvalId!==request.approvalId));
  };
  const sendRuntime=async(prompt:string,files:Attachment[])=>{
    const initial=runtimeRef.current;
    if(!initial||initial.status!=='connected'){setConnectionMode('runtime');setSettings('connection');notify(agent==='claude'?'請先連接朋友的 Claude Runtime。':'請先連線到朋友電腦上的 Codex Runtime。');return;}
    let active:RuntimeConnection=initial;
    if(!active.account.authenticated){
      setRuntimeBusy(true);
      try{const refreshed=await engineApi(active.agent||'codex').status(active.runtimeId);if(runtimeRef.current?.runtimeId!==active.runtimeId)return;applyRuntime(refreshed,active.hostName||'Runtime',active.hostKey||'');active={...active,...refreshed};}
      catch{notify('登入狀態更新失敗，草稿已保留。請使用下方的重新檢查登入。');return;}
      finally{setRuntimeBusy(false);}
      if(!active.account.authenticated){notify(runtimeReadiness(active).label+'；草稿已保留，請查看輸入框下方的登入狀態。');return;}
    }
    if(!active.capabilities.localTools){setConnectionMode('runtime');setSettings('connection');notify('Mac 工具通道尚未就緒，暫不開始對話。朋友電腦不會代替 Mac 執行工具。');return;}
    if(!localCwd.trim()){setConnectionMode('runtime');setSettings('connection');notify('請先選擇這台 Mac 的工作資料夾。');return;}
    const prior=current?.agent===agent?current:undefined;
    const nativeResume=!!prior&&(agent==='claude'||(!!prior.executorEnvironmentId&&prior.executorEnvironmentId===active.executorEnvironment?.environmentId))&&prior.transport==='runtime'&&prior.hostKey===active.hostKey&&prior.localCwd===localCwd&&!prior.recoveryNeeded&&!!prior.remoteId;
    const restoreContext=!!prior&&!nativeResume;
    if(restoreContext)notify('已在同一段對話接續，使用本機文字歷史補上上下文。');
    const chatId=prior?.id||crypto.randomUUID(),messageId=crypto.randomUUID(),requestId=crypto.randomUUID(),now=Date.now();
    const userMessage:Message={id:crypto.randomUUID(),role:'user',text:prompt,attachments:files};const answer:Message={id:messageId,role:'assistant',text:'',status:'running'};
    setChats(previous=>prior?previous.map(chat=>chat.id===chatId?{...chat,transport:'runtime',hostKey:active.hostKey,localCwd,remoteId:nativeResume?chat.remoteId:undefined,executorEnvironmentId:nativeResume?chat.executorEnvironmentId:active.executorEnvironment?.environmentId,recoveryNeeded:restoreContext,updatedAt:now,model:runtimeModel,messages:[...chat.messages,userMessage,answer]}:chat):[{id:chatId,title:prompt.slice(0,40)||files[0]?.name||'新對話',messages:[userMessage,answer],createdAt:now,updatedAt:now,agent,transport:'runtime',projectId:projectId||undefined,hostKey:active.hostKey,localCwd,executorEnvironmentId:active.executorEnvironment?.environmentId,model:runtimeModel},...previous]);
    followBottom.current=true;composer.clear();setCurrentId(chatId);setPage('chat');
    setUsageRecords(previous=>[...previous,{requestId,agent,authMode:active.authMode,hostKey:active.hostKey||'',model:runtimeModel,startedAt:now,status:'running'} as UsageRecord].slice(-5000));
    const running={requestId,chatId,messageId,sessionId:active.runtimeId,transport:'runtime' as const,agent,activity:agent==='claude'?'Claude Code 正在思考…':'Codex 正在思考…'};workingRef.current=running;setWorking(running);
    try{await engineApi(active.agent||'codex').send({runtimeId:active.runtimeId,requestId,prompt:restoreContext?continuationContext(prior!.messages)+'\n\nNew user request:\n'+prompt:prompt,conversationId:nativeResume?prior!.remoteId:undefined,executorEnvironmentId:nativeResume?prior!.executorEnvironmentId:undefined,model:runtimeModel||undefined,effort:runtimeEffort||undefined,localCwd,attachments:files.map(file=>file.id),autoCompactPercent:active.agent==='claude'?claudeAutoCompactPercent:codexAutoCompactPercent,customInstructions:customInstructions.trim()||undefined,temporary:current?.temporary||undefined});}
    catch(e){setUsageRecords(previous=>previous.map(record=>record.requestId===requestId?{...record,status:'error',finishedAt:Date.now()}:record));setChats(previous=>previous.map(chat=>chat.id===chatId?{...chat,messages:chat.messages.map(message=>message.id===messageId?{...message,status:'error',text:e instanceof Error?e.message:String(e)}:message)}:chat));workingRef.current=null;setWorking(null);}
  };
  const sendCollaboration=async(prompt:string,files:Attachment[])=>{
    if(files.length){notify('雙 Agent 自動討論目前是純文字模式；請先移除附件。');return;}
    const codex=connectionsRef.current.codex,claude=connectionsRef.current.claude;
    if(!codex||codex.status!=='connected'||!codex.account?.authenticated){
      setAgent('codex');setConnectionMode('runtime');setSettings('connection');notify('請先連線並登入 Codex Runtime。');return;
    }
    if(!claude||claude.status!=='connected'||!claude.account?.authenticated){
      setAgent('claude');setConnectionMode('runtime');setSettings('connection');notify('請先連線並登入 Claude Code。');return;
    }
    if(!codex.capabilities?.localTools){setAgent('codex');setConnectionMode('runtime');setSettings('connection');notify('Codex 的 Mac Executor 尚未就緒，無法啟動自動討論。');return;}
    const prior=current?.agent===agent?current:undefined;
    const chatId=prior?.id||crypto.randomUUID(),messageId=crypto.randomUUID(),now=Date.now();
    const userMessage:Message={id:crypto.randomUUID(),role:'user',text:prompt};
    const answer:Message={id:messageId,role:'assistant',text:`> **Codex ↔ Claude 自動討論** · ${collabRounds} 輪 · ${collabRounds*2+1} 次模型回合\n\n`,status:'running'};
    setChats(previous=>prior?previous.map(chat=>chat.id===chatId?{...chat,transport:'orchestrator',remoteId:undefined,recoveryNeeded:true,updatedAt:now,messages:[...chat.messages,userMessage,answer]}:chat):[{id:chatId,title:`雙 Agent：${prompt.slice(0,34)}`,messages:[userMessage,answer],createdAt:now,updatedAt:now,agent,transport:'orchestrator',projectId:projectId||undefined,hostKey:`${codex.hostKey||codex.runtimeId}|${claude.hostKey||claude.runtimeId}`},...previous]);
    followBottom.current=true;composer.clear();setCurrentId(chatId);setPage('chat');
    try{
      const started=await api().orchestrator.start({
        codexRuntimeId:codex.runtimeId,
        claudeRuntimeId:claude.runtimeId,
        topic:prior?continuationContext(prior.messages)+'\n\nNew user request:\n'+prompt:prompt,
        rounds:collabRounds,
        leadAgent:agent,
        codexModel:modelsByAgent.codex||undefined,
        claudeModel:modelsByAgent.claude||undefined,
        codexEffort:effortsByAgent.codex||undefined,
        claudeEffort:effortsByAgent.claude||undefined
      });
      const running={requestId:started.runId,chatId,messageId,sessionId:started.conversationId,transport:'orchestrator' as const,agent,activity:`Codex 與 Claude 正在開始 ${collabRounds} 輪討論…`};
      workingRef.current=running;setWorking(running);
    }catch(e){
      const reason=e instanceof Error?e.message:String(e);
      setChats(previous=>previous.map(chat=>chat.id===chatId?{...chat,messages:chat.messages.map(message=>message.id===messageId?{...message,status:'error',text:`## 無法啟動雙 Agent 討論\n\n${reason}`}:message)}:chat));
      workingRef.current=null;setWorking(null);
    }
  };
  const chooseDevice=async(profile?:Profile)=>{
    if(connecting||workingRef.current)return;
    setConnecting(true);
    try{
      const active=connectionsRef.current[agent];
      if(active){await engineApi().disconnect(active.runtimeId);setRuntime(null);runtimeRef.current=null;}
      if(session&&connectionMode==='ssh'){await api().ssh.disconnect(session.sessionId);setSession(null);}
      setRecovering(false);manualDisconnect.current=false;setConnectionError(null);setHostConfirmation(null);
      setDraft(profile?{...profile,password:''}:newProfile());
      setRuntimePlatform(profileRuntimePlatform(profile||{}));
      if(profile)try{localStorage.setItem('studio.lastProfileId',JSON.stringify(profile.id));}catch{}
    }finally{setConnecting(false);}
  };
  const saveProfile=async()=>{setProfiles(await api().profiles.save({...draft,runtimePlatform}));notify('連線設定已儲存');};
  const send=async(retryText?:string,retryAttachments?:Attachment[])=>{
    if(!historyReady||!composer.ready){notify('正在讀取本機對話，請稍候。');return;}
    const prompt=retryText??input.trim();const files=retryAttachments??attachments;
    if((!prompt&&!files.length)||workingRef.current||sendPending.current||runtimeBusy||importing)return;
    sendPending.current=true;
    try{if(collabMode)await sendCollaboration(prompt,files);else await sendRuntime(prompt,files);}
    finally{sendPending.current=false;}
  };
  useEffect(()=>{
    // Keep an explicit disconnect disconnected even after the API key was cleared
    // on successful connection. Changing the selection still enables retry.
    if(runtime){connectionSelection.current.begin();return;}
    if(agent==='claude'&&claudeAuthMode==='api'&&claudeBaseUrl.trim()&&!claudeApiKey)return;
    if(!historyReady||!autoConnect||connectionMode!=='runtime'||!profilesLoaded||connecting||runtime||(!draft.relayUrl&&draft.networkMode!=='relay'&&(!draft.host||!draft.username))||!localCwd.trim()||hostConfirmation||workingRef.current)return;
    if(!connectionSelection.current.canAutoConnect())return;
    // Editing a new or changed target must wait for explicit save/connect.
    if(!profiles.some(profile=>profile.id===draft.id&&profile.host===draft.host&&profile.username===draft.username&&profile.port===draft.port&&profile.authType===draft.authType&&profile.keyPath===draft.keyPath&&(profile.networkMode||'auto')===(draft.networkMode||'auto')&&(profile.relayUrl||'')===(draft.relayUrl||'')&&profileRuntimePlatform(profile)===runtimePlatform))return;
    if(!draft.relayUrl&&draft.networkMode!=='relay'&&draft.authType==='password'&&!draft.hasSavedPassword&&!draft.password)return;
    safe(()=>connectRuntime(undefined,true));
  },[historyReady,connectionSignature,profiles,profilesLoaded,connecting,runtime?.runtimeId,hostConfirmation,working]);

  useEffect(()=>{if(!historyReady||!recovering||!autoConnect||manualDisconnect.current||runtime||connecting||hostConfirmation||working||!profilesLoaded||!localCwd.trim())return;
    if(!profiles.some(profile=>profile.id===draft.id&&profile.host===draft.host&&profile.username===draft.username&&profile.port===draft.port&&profile.authType===draft.authType&&profile.keyPath===draft.keyPath&&(profile.networkMode||'auto')===(draft.networkMode||'auto')&&(profile.relayUrl||'')===(draft.relayUrl||'')&&profileRuntimePlatform(profile)===runtimePlatform))return;
    if(agent==='claude'&&claudeAuthMode==='api'&&claudeBaseUrl.trim()&&!claudeApiKey)return;const delay=Math.min(15000,1000*2**Math.min(recoveryAttempt.current++,4))*(0.9+Math.random()*0.1);const timer=setTimeout(()=>{safe(()=>connectRuntime(undefined,true));},delay);return()=>clearTimeout(timer);},[historyReady,recovering,autoConnect,connecting,runtime?.runtimeId,connectionSignature,hostConfirmation,working,profiles,profilesLoaded]);
  useEffect(()=>{const wake=()=>{if(!manualDisconnect.current&&autoConnectRef.current&&!runtimeRef.current){recoveryAttempt.current=0;setRecovering(true);}};window.addEventListener('online',wake);const off=api().network?.onEvent((e:any)=>{if(e.type==='resume')wake();});return()=>{window.removeEventListener('online',wake);off?.();};},[]);
  const patchChat=(id:string,patch:Partial<Chat>)=>{setChats(prev=>prev.map(chat=>chat.id===id?{...chat,...patch}:chat));setChatMenu(null);};
  const downloadBlob=(filename:string,blob:Blob)=>{const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const exportChats=()=>{downloadBlob('agentbridge-conversations.json',new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),chats,projects},null,2)],{type:'application/json'}));notify('已匯出對話與專案');};
  const exportMarkdown=(chat:Chat)=>{downloadBlob(`${sanitizeFilename(chat.title)}.md`,new Blob([chatToMarkdown(chat)],{type:'text/markdown;charset=utf-8'}));notify(`已匯出「${chat.title}」為 Markdown`);setChatMenu(null);};

  // --- A2: find in current conversation (⌘F) ---
  const chatSearchHits=useMemo(()=>{const target=current?chats.find(chat=>chat.id===current.id):null;if(!target||!chatSearch)return[];return findInConversation(target,chatSearch);},[current?.id,chats,chatSearch]);
  const openChatSearch=()=>{if(!current)return;const next=!chatSearch;setChatSearch(next?'':null);setChatSearchIndex(0);};
  const jumpChatSearch=(delta:number)=>{if(!chatSearchHits.length)return;const n=chatSearchHits.length;setChatSearchIndex(prev=>(prev+delta+n)%n);};
  const searchHitMessageId=chatSearch&&chatSearchHits.length?chatSearchHits[Math.min(chatSearchIndex,chatSearchHits.length-1)].messageId:null;  const jumpToMessage=(chatId:string,messageId:string)=>{setChatSearch(null);if(currentId!==chatId)setCurrentId(chatId);setHistoryEnd(null);requestAnimationFrame(()=>document.getElementById(`message-${messageId}`)?.scrollIntoView({behavior:reduceMotion?'instant':'smooth',block:'center'}));};

  // --- A1: edit a sent message and resend ---
  const startEditMessage=(chatId:string,messageId:string)=>{const chat=chats.find(item=>item.id===chatId);const message=chat?.messages.find(item=>item.id===messageId);if(!message||message.role!=='user')return;setEditMessage({chatId,messageId,text:message.text});};  const commitEditMessage=async()=>{if(!editMessage||!current)return;const{chatId,messageId,text}=editMessage;const trimmed=text.trim();if(!trimmed){notify('訊息內容不能為空。');return;}const chat=chats.find(item=>item.id===chatId);if(!chat)return;const index=chat.messages.findIndex(message=>message.id===messageId);if(index===-1)return;setEditMessage(null);const base=chat.messages.slice(0,index+1).map((message,offset)=>offset===index?{...message,text:trimmed}:message);setChats(prev=>prev.map(item=>item.id===chatId?{...item,recoveryNeeded:true,updatedAt:Date.now(),messages:base}:item));setInput('');setAttachments([]);await send(trimmed);};

  // --- A4: branch a conversation from a message ---
  const branchFromMessage=(chatId:string,messageId:string)=>{const chat=chats.find(item=>item.id===chatId);if(!chat)return;const created=branchChat(chat,messageId,()=>crypto.randomUUID(),Date.now());if(!created)return;setChats(prev=>[created,...prev]);setCurrentId(created.id);setPage('chat');notify(`已從訊息建立「${created.title}」，沿用先前上下文。`);};

  // --- A5: temporary chat ---
  const startTemporary=()=>{const id=crypto.randomUUID();const now=Date.now();const chat:Chat={id,title:'臨時對話',messages:[],createdAt:now,updatedAt:now,agent,temporary:true};setChats(prev=>[chat,...prev]);setCurrentId(id);setPage('chat');setInput('');setAttachments([]);setChatMenu(null);};

  // --- A10: bookmark a message ---
  const toggleBookmark=(chatId:string,messageId:string)=>{setChats(prev=>prev.map(chat=>{if(chat.id!==chatId)return chat;const set=new Set(chat.bookmarks||[]);if(set.has(messageId))set.delete(messageId);else set.add(messageId);return{...chat,bookmarks:[...set],updatedAt:Date.now()};}));};
  const bookmarkTarget=(chatId:string,messageId:string)=>{const chat=chats.find(item=>item.id===chatId);return chat?.bookmarks?.includes(messageId)?'移除書籤':'加入書籤';};

  // --- A3: read the latest reply aloud (macOS `say`) ---
  const speakMessage=(chatId:string,messageId:string)=>{const chat=chats.find(item=>item.id===chatId);const message=chat?.messages.find(item=>item.id===messageId);if(!message||!message.text.trim())return;if(ttsActive.current===messageId){speechSynthesis.cancel();ttsActive.current=null;return;}ttsActive.current=messageId;const utterance=new SpeechSynthesisUtterance(message.text);utterance.lang='zh-TW';utterance.onend=()=>{if(ttsActive.current===messageId)ttsActive.current=null;};utterance.onerror=()=>{if(ttsActive.current===messageId)ttsActive.current=null;notify('語音朗讀無法開始，請確認系統語音已安裝。');};speechSynthesis.speak(utterance);};
  const stopSpeaking=()=>{if(ttsActive.current){speechSynthesis.cancel();ttsActive.current=null;}};

  // --- A8: open a fresh window ---
  const openNewWindow=()=>safe(async()=>{if(api().system?.openWindow)await api().system.openWindow();else notify('此版本不支援多視窗。');});

  // --- A9: desktop notification when a turn finishes ---
  const notifyDesktop=(text:string)=>{if(!desktopNotifications)return;if(document.hasFocus())return;safe(async()=>{if(api().system?.notify)await api().system.notify(text);});};
  hotkeys.current={openChatSearch,openNewWindow,startTemporary};
  const visibleChats=useMemo(()=>chats.filter(chat=>!chat.archived&&!chat.temporary).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt-a.updatedAt),[chats]);
  const searchChats=useMemo(()=>chats.filter(chat=>(historyMode==='archived'?chat.archived:!chat.archived)&&!chat.temporary&&(!search||chat.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())||chat.messages.some(message=>message.text.toLocaleLowerCase().includes(search.toLocaleLowerCase())))),[chats,search,historyMode]);
  const shownExtensions=extensions.filter(item=>item.agent===agent).filter(item=>(extensionTab==='all'||item.kind===extensionTab)&&(item.name+' '+(item.description||'')).toLowerCase().includes(extensionSearch.toLowerCase()));
  const shownFiles=library.filter(file=>file.name.toLowerCase().includes(fileSearch.toLowerCase()));
  const activeTheme=theme==='system'?(systemDark?'dark':'light'):theme;
  const settingsNav:Array<[Setting,string,string]>=[['general','settings','一般'],['connection','link','連線與 Agent'],['data','shield','資料與儲存'],['shortcuts','terminal','鍵盤快捷鍵'],['advanced','computer','進階工具'],['about','info','關於']];
  const noConnection=(title:string,description:string)=><div className="standalone-empty"><div className="empty-symbol"><Glyph name="link" size={30}/></div><h2>{title}</h2><p>{description}</p><button className="primary" onClick={()=>{setConnectionMode('ssh');openSettings('connection');}}>設定遠端連線<Glyph name="arrow" size={16}/></button></div>;
  const conversationMenu=(chat:Chat)=><div className="popup-menu chat-context"><button onClick={()=>patchChat(chat.id,{pinned:!chat.pinned})}><Glyph name="pin"/>{chat.pinned?'取消釘選':'釘選對話'}</button><button onClick={()=>{setRename({kind:'chat',id:chat.id,value:chat.title});setChatMenu(null);}}><Glyph name="new"/>重新命名</button><button onClick={()=>exportMarkdown(chat)}><Glyph name="export" size={16}/>匯出為 Markdown</button><button onClick={()=>patchChat(chat.id,{archived:!chat.archived})}><Glyph name="archive"/>{chat.archived?'還原對話':'封存對話'}</button>{projects.length>0&&<label className="move-project">移至專案<select value={chat.projectId||''} onChange={e=>patchChat(chat.id,{projectId:e.target.value||undefined})}><option value="">沒有專案</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}<div className="menu-divider"/>{chat.temporary&&<button className="danger-text" onClick={()=>{setChats(prev=>prev.map(item=>item.id===chat.id?{...item,temporary:false}:item));setChatMenu(null);notify('已將臨時對話保留到歷史紀錄。');}}><Glyph name="archive" size={16}/>保留此對話</button>}<button className="danger-text" disabled={working?.chatId===chat.id} onClick={()=>{setDeleteChat(chat.id);setChatMenu(null);}}><Glyph name="trash"/>刪除對話</button></div>;
  const fileCard=(file:Attachment,select=false)=><div className="library-file" key={file.id}><div className="file-tile"><AttachmentVisual file={file} large/><span>{file.name.split('.').at(-1)?.toUpperCase().slice(0,8)||'FILE'}</span></div><div className="library-file-meta"><b title={file.name}>{file.name}</b><span>{formatBytes(file.size)} · {dateLabel(file.addedAt)}</span></div><div className="file-actions">{select?<button className="secondary compact" onClick={()=>{setAttachments(prev=>prev.some(item=>item.id===file.id)?prev:[...prev,file]);setPicker(false);setPage('chat');}}>加入對話</button>:<><button className="icon-btn" title="加入對話" aria-label={`將 ${file.name} 加入對話`} onClick={()=>{setAttachments(prev=>prev.some(item=>item.id===file.id)?prev:[...prev,file]);setPage('chat');}}><Glyph name="plus" size={17}/></button><button className="icon-btn" title="在 Finder 中顯示" aria-label={`顯示 ${file.name}`} onClick={()=>safe(()=>api().system.reveal(file.localPath))}><Glyph name="folder" size={17}/></button><button className="icon-btn" title="從檔案庫移除，不刪除原始檔" aria-label={`移除 ${file.name}`} onClick={()=>safe(async()=>{await api().library.remove(file.id);await refreshLibrary();setAttachments(prev=>prev.filter(item=>item.id!==file.id));})}><Glyph name="trash" size={17}/></button></>}</div></div>;

  return <MotionConfig reducedMotion={reduceMotion?'always':'user'}><motion.div className={`studio ${sidebar?'':'sidebar-collapsed'} ${reduceMotion?'reduce-motion':''} ${sidebarDragging?'resizing':''}`} style={{'--sidebar-w':sidebarWidthCss} as never} data-theme={activeTheme} onDragEnter={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();dragDepth.current++;setDragging(true);}}} onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}} onDragLeave={()=>{dragDepth.current--;if(dragDepth.current<=0)setDragging(false);}} onDrop={event=>safe(()=>handleDrop(event))}>
    <SidebarResizer width={sidebarWidthMotion} visible={sidebar} handlers={sidebarHandlers} dragging={sidebarDragging} onCollapse={()=>setSidebar(false)} onExpand={()=>setSidebar(true)}/>
    <aside className="studio-sidebar" aria-label="主要側邊欄" inert={!sidebar}>
      <div className="sidebar-titlebar"><span className="window-drag-area"/><button className="icon-btn" title="收合側邊欄（⌘ B）" aria-label="收合側邊欄" onClick={()=>setSidebar(false)}><Glyph name="panel"/></button></div>
      <button className="studio-brand" onClick={()=>{setProjectId(null);startNew();}}><span className="brand-emblem"><Glyph name="spark" size={22}/></span><span>AgentBridge<small>Studio</small></span></button>
      <nav className="primary-nav">
        <button onClick={()=>{setProjectId(null);startNew();}}><Glyph name="new"/><span>新對話</span><kbd>⇧ ⌘ N</kbd></button>
        <button onClick={()=>{setProjectId(null);startTemporary();}} className={current?.temporary?'selected':''}><Glyph name="archive"/><span>臨時對話</span><kbd>⌘ T</kbd></button>
        <button onClick={()=>setTemplateModal(true)}><Glyph name="apps"/><span>提示範本</span><kbd>⇧ ⌘ U</kbd></button>
        <button onClick={()=>{setSearch('');setSearchOpen(true);}}><Glyph name="search"/><span>搜尋對話</span><kbd>⌘ K</kbd></button>
        <button className={page==='library'?'selected':''} onClick={()=>setPage('library')}><Glyph name="library"/><span>檔案庫</span>{library.length>0&&<small>{library.length}</small>}</button>
        <button className={page==='apps'?'selected':''} onClick={()=>setPage('apps')}><Glyph name="apps"/><span>應用程式與外掛</span></button>
        <button className={page==='usage'?'selected':''} onClick={()=>setPage('usage')}><Glyph name="history"/><span>用量與報告</span></button>
      </nav>
      <div className="sidebar-scroll">
        <div className="sidebar-section-title"><span>專案</span><button className="icon-btn tiny" title="新增專案" aria-label="新增專案" onClick={()=>setProjectModal(true)}><Glyph name="plus" size={16}/></button></div>
        <div className="project-list">{projects.map(project=><button key={project.id} className={page==='project'&&projectId===project.id?'selected':''} onClick={()=>{setProjectId(project.id);setPage('project');}}><Glyph name="folder" size={18}/><span>{project.name}</span></button>)}{!projects.length&&<button className="subtle-action" onClick={()=>setProjectModal(true)}><Glyph name="folder" size={18}/>建立你的第一個專案</button>}</div>
        <div className="sidebar-section-title"><span>最近的對話</span><button className="icon-btn tiny" title="所有歷史紀錄" aria-label="所有歷史紀錄" onClick={()=>{setSearch('');setPage('history');}}><Glyph name="history" size={16}/></button></div>
        <div className="recent-list">{visibleChats.slice(0,40).map(chat=><div className={`recent-item context-anchor ${currentId===chat.id&&page==='chat'?'selected':''}`} key={chat.id}><button className="recent-title" onClick={()=>openChat(chat)}>{chat.pinned&&<Glyph name="pin" size={13}/>}<span>{chat.title}</span>{working?.chatId===chat.id&&<i className="thinking-dot"/>}</button><button className="recent-more icon-btn tiny" aria-label={`${chat.title} 選單`} title="對話選單" onClick={()=>setChatMenu(chatMenu===chat.id?null:chat.id)}><Glyph name="more" size={18}/></button>{chatMenu===chat.id&&conversationMenu(chat)}</div>)}{!visibleChats.length&&<div className="sidebar-empty-copy">對話會保存在這裡，<br/>隨時都能接著聊。</div>}</div>
        <div className="sidebar-section-title"><span>工作工具</span></div>
        <nav className="utility-nav">{([['remote','folder','遠端檔案'],['computer','computer','電腦與瀏覽器'],['terminal','terminal','終端機']] as const).map(([key,icon,label])=><button key={key} className={page===key?'selected':''} onClick={()=>setPage(key)}><Glyph name={icon} size={18}/><span>{label}</span></button>)}</nav>
      </div>
      <div className="sidebar-bottom"><button className="connection-button" onClick={()=>openSettings('connection')}><i className={`connection-dot ${runtimeReadiness(runtime).ready?'online':runtime?'attention':''}`}/><span>{agent==='codex'?(runtime?.hostName||'連接 Codex Runtime'):(runtime?.hostName||'啟動 Claude Code')}</span><Glyph name="down" size={14}/></button><button className="profile-button" onClick={()=>openSettings()}><span className="profile-avatar">A</span><span><b>我的工作空間</b><small>本機個人空間</small></span><Glyph name="settings" size={18}/></button></div>
    </aside>
    <main className="studio-main" data-scrolling={scrolling?'true':undefined}>
      <header className="studio-topbar"><div className="topbar-left"><div className="segmented topbar-agent-modes" aria-label="Agent 模式">{(['codex','claude'] as const).map(provider=><button key={provider} disabled={!!working||connecting} className={agent===provider?'active':''} onClick={()=>{setAgent(provider);setModelMenu(false);if(current?.agent!==provider)startNew();}}>{provider==='codex'?'Codex':'Claude Code'}</button>)}</div>{!sidebar&&<button className="icon-btn expand-sidebar" title="展開側邊欄（⌘ B）" aria-label="展開側邊欄" onClick={()=>setSidebar(true)}><Glyph name="panel"/></button>}<div className="popover-anchor"><button className="model-button" aria-expanded={modelMenu} onClick={()=>setModelMenu(!modelMenu)}>{runtime?.models.find(model=>model.id===runtimeModel)?.displayName||runtimeModel||(agent==='codex'?'Codex':'Claude Code')}<Glyph name="down" size={16}/></button>{modelMenu&&<div className="popup-menu model-menu"><div className="menu-caption">選擇對話 Agent</div>{(['codex','claude'] as const).map(value=><button key={value} disabled={!!working||connecting} onClick={()=>{setAgent(value);setModelMenu(false);if(current&&current.agent!==value){startNew();notify('已切換 Agent，開啟新的對話。');}}}><span className="agent-symbol"><Glyph name={value==='codex'?'code':'spark'}/></span><span><b>{value==='codex'?'Codex':'Claude Code'}</b><small>{value==='codex'?'Runtime 模型，Mac 工作工具':'朋友的 Claude Runtime，Mac 工作工具'}</small></span>{agent===value&&<Glyph name="check" size={17}/>}</button>)}{runtime&&<><div className="runtime-model-menu"><div className="menu-caption">{agent==='claude'?'Claude Code 提供的模型':'Runtime 提供的模型'}</div>{runtime.models.map(model=><button key={model.id} disabled={!!working||connecting} onClick={()=>{setRuntimeModel(model.id);setRuntimeEffort(model.defaultReasoningEffort||'');}}><span>{model.displayName||model.id}</span>{runtimeModel===model.id&&<Glyph name="check" size={15}/>}</button>)}</div>{agent==='claude'&&runtime.authMode==='api'&&<div className="model-custom-field"><label>其他供應商模型 ID<input aria-label="自訂 API 模型 ID" value={customModel} onChange={e=>setCustomModel(e.target.value)} placeholder="供應商提供的模型 ID"/></label><button disabled={!!working||!customModel.trim()} onClick={()=>{setRuntimeModel(customModel.trim());setRuntimeEffort('');setModelMenu(false);}}>使用此模型</button><small>模型 ID 須由你的供應商支援，送出後以實際回覆驗證。</small></div>}{reasoningOptions(runtime.models.find(model=>model.id===runtimeModel)).length>0&&<label className="runtime-effort-select">推理程度<select aria-label="對話推理程度" value={runtimeEffort} disabled={!!working||connecting} onChange={event=>setRuntimeEffort(event.target.value)}>{reasoningOptions(runtime.models.find(model=>model.id===runtimeModel)).map(effort=><option key={effort} value={effort}>{effort}</option>)}</select></label>}</>}<div className="menu-divider"/><button onClick={()=>openSettings('connection')}><Glyph name="settings"/>連線與 Agent 設定</button></div>}</div>{currentProject&&page==='chat'&&<span className="topbar-project"><Glyph name="folder" size={14}/>{currentProject.name}</span>}</div><div className="topbar-right"><QuotaPopover activeAgent={agent} runtime={connections.codex} quota={quota} claudeRuntime={connections.claude} claudeQuota={claudeQuota} busy={quotaBusy||claudeQuotaBusy} onRefresh={()=>void refreshQuota()} onClaudeRefresh={()=>void refreshClaudeQuota(true)} onReport={()=>setPage('usage')} onConnect={(target)=>{if(target)setAgent(target);openSettings('connection');}}/>{runtimeRequests.length>0&&<button className="runtime-pending-chip" onClick={()=>{if(workingRef.current)setCurrentId(workingRef.current.chatId);setPage('chat');}}><Glyph name="shield" size={15}/>待處理 {runtimeRequests.length}</button>}<span className={`connection-label ${runtimeReadiness(runtime).ready?'connected':''}`}><i className={`connection-dot ${runtimeReadiness(runtime).ready?'online':runtime?'attention':''}`} />{recovering?'正在恢復連線…':runtime?runtimeReadiness(runtime).label:'本機工作空間'}</span>{current&&page==='chat'&&<div className="context-anchor"><button className="icon-btn" title="對話選單" aria-label="對話選單" onClick={()=>setChatMenu(chatMenu===`header:${current.id}`?null:`header:${current.id}`)}><Glyph name="more"/></button>{chatMenu===`header:${current.id}`&&conversationMenu(current)}</div>}<button className="icon-btn" title="設定（⌘ ,）" aria-label="設定" onClick={()=>openSettings()}><Glyph name="settings"/></button></div></header>
      <div className={`studio-content ${page==='chat'?'chat-content':''}`} onScrollCapture={markScrolling}>
        {page==='chat'&&<div className={`chat-page ${current?'has-messages':'is-empty'}`}>
          {current?<div className="messages-scroll" onScroll={event=>{const el=event.currentTarget;const near=el.scrollHeight-el.scrollTop-el.clientHeight<90;followBottom.current=near;setShowScrollDown(!near);}}><div className="messages-column">{current.recoveryNeeded&&<div className="settings-error" role="status">正在以本機文字紀錄接續這段對話，原有紀錄仍保留；附件需重新加入，已執行的工具不會自動重播。</div>}{visibleMessages.start>0&&<button className="secondary history-page-button" onClick={()=>{followBottom.current=false;setHistoryEnd(visibleMessages.start);}}>查看更早訊息</button>}{current.messages.slice(visibleMessages.start,visibleMessages.end).map((message,offset)=>{const index=visibleMessages.start+offset;return <article className={`message ${message.role} ${searchHitMessageId===message.id?'search-highlight':''} ${current.bookmarks?.includes(message.id)?'bookmarked':''}`} id={`message-${message.id}`} key={message.id}>{message.role==='assistant'&&<div className="assistant-mark"><Glyph name={current.agent==='codex'?'code':'spark'} size={21}/></div>}<div className="message-content">{message.compactions?.map((compact,i)=><p className="page-note" key={i}>上下文已壓縮{compact.preTokens!==null?` · 原本 ${compact.preTokens.toLocaleString()} tokens`:""}{compact.postTokens!==null?` → ${compact.postTokens.toLocaleString()}`:""} · {new Date(compact.at).toLocaleTimeString()}</p>)}{!!message.attachments?.length&&<div className="message-attachments">{message.attachments.map(file=><span key={file.id}><AttachmentVisual file={file}/><span>{file.name}<small>{formatBytes(file.size)}</small></span></span>)}</div>}{message.tools?.length?<div className="message-tool-list" aria-label="工具活動">{message.tools.map(tool=><div className="message-tool-group" key={tool.itemId}><div className={`message-tool ${tool.status}`}><Glyph name={tool.status==='completed'?'check':tool.status==='error'?'info':'bolt'} size={15}/><span>{tool.title}<small>{tool.executionLocation==='local'?'這台 Mac':tool.executionLocation==='remote'?'Runtime 主機':''}{tool.durationMs!==undefined?` · ${(tool.durationMs/1000).toFixed(1)} 秒`:''}</small></span><i>{tool.status==='running'?'執行中':tool.status==='completed'?'完成':'未完成'}</i></div>{toolResults[tool.itemId]?.image&&<img className="tool-result-image" src={toolResults[tool.itemId].image} alt="Mac 工具回傳的畫面"/>}{toolResults[tool.itemId]?.text&&<details className="tool-result-output"><summary>查看工具結果</summary><pre>{toolResults[tool.itemId].text}</pre></details>}</div>)}</div>:null}{message.text?<MessageBody text={message.text} streaming={message.status==='running'}/>:message.role==='user'?null:message.status==='running'?<div className="thinking-status"><i className="thinking-dot"/>{working?.activity||'正在思考…'}</div>:<p className="muted-text error-text">{message.status==='cancelled'?'已停止回覆。':(message.status==='error'?'Runtime 回報執行失敗，但未提供具體原因。原有紀錄已保留。':'Agent 未回傳文字。')}</p>}{message.status==='running'&&message.text&&<div className="thinking-status small"><i className="thinking-dot"/>{working?.activity}</div>}{message.status==='error'&&<div className="message-state error">執行未完成</div>}{message.status==='cancelled'&&message.text&&<div className="message-state">已停止</div>}<div className="message-actions"><button className="icon-btn tiny" title="複製訊息" aria-label="複製訊息" onClick={()=>safe(async()=>{await navigator.clipboard.writeText(message.text);notify('已複製');})}><Glyph name="copy" size={16}/></button>{message.role==='user'&&message.status!=='running'&&<button className="icon-btn tiny" title="編輯並重送" aria-label="編輯並重送" disabled={!!working||connecting} onClick={()=>startEditMessage(current.id,message.id)}><Glyph name="new" size={16}/></button>}{message.role==='assistant'&&message.status!=='running'&&<button className="icon-btn tiny" title="重新回覆" aria-label="重新回覆" disabled={!!working||connecting} onClick={()=>{const lastUser=current.messages.slice(0,index).reverse().find(item=>item.role==='user');if(lastUser)safe(()=>send(lastUser.text,lastUser.attachments));}}><Glyph name="refresh" size={16}/></button>}{message.status!=='running'&&<><button className="icon-btn tiny" title={bookmarkTarget(current.id,message.id)} aria-label={bookmarkTarget(current.id,message.id)} onClick={()=>toggleBookmark(current.id,message.id)}><Glyph name="pin" size={15}/></button><button className="icon-btn tiny" title="從這則訊息建立分支" aria-label="建立分支" disabled={!!working||connecting} onClick={()=>branchFromMessage(current.id,message.id)}><Glyph name="code" size={15}/></button>{message.text.trim()&&<button className={`icon-btn tiny ${ttsActive.current===message.id?'active-tts':''}`} title={ttsActive.current===message.id?'停止朗讀':'朗讀這則回覆'} aria-label="朗讀回覆" onClick={()=>speakMessage(current.id,message.id)}><Glyph name="mic" size={15}/></button>}</>}</div></div></article>;})}{visibleMessages.end<current.messages.length&&<button className="secondary history-page-button" onClick={()=>{followBottom.current=false;const end=Math.min(current.messages.length,visibleMessages.end+40);followBottom.current=end===current.messages.length;setHistoryEnd(end===current.messages.length?null:end);}}>查看後續訊息</button>}<div ref={messageEnd}/></div></div>:<div className="welcome-heading"><div className="welcome-wordmark"><Glyph name="spark" size={32}/><span>AgentBridge</span></div><h1>今天，有什麼想一起完成？</h1><p>從一個想法開始，讓你的 Agent 接手。</p></div>}
          {showScrollDown&&current&&<button className="scroll-to-bottom icon-btn" title="跳到最新訊息" aria-label="跳到最新訊息" onClick={()=>{followBottom.current=true;messageEnd.current?.scrollIntoView({behavior:reduceMotion?'instant':'smooth'});setShowScrollDown(false);}}><Glyph name="down" size={18}/></button>}{runtimeRequests.length>0&&<div className="runtime-request-stack">{runtimeRequests.map(request=><RuntimePendingRequest key={request.approvalId} request={request} onRespond={(decision,answers)=>respondToRuntime(request,decision,answers)} onCancel={cancelWork}/>)}</div>}<div className="composer-area"><div className="composer-wrap"><div className="composer-box">{attachments.length>0&&<div className="attachment-tray">{attachments.map(file=><div className="attachment-chip" key={file.id}><AttachmentVisual file={file}/><span><b>{file.name}</b><small>{formatBytes(file.size)}</small></span><button className="icon-btn tiny" title="移除附件" aria-label={`移除附件 ${file.name}`} onClick={()=>setAttachments(prev=>prev.filter(item=>item.id!==file.id))}><Glyph name="close" size={14}/></button></div>)}</div>}<textarea ref={composerRef} onPaste={event=>void handlePaste(event)} aria-label="訊息" placeholder={working?`正在執行中… 輸入新提示可打斷並插入（Enter）`:collabMode?'輸入要讓 Codex 與 Claude 討論的主題':'傳送訊息，拖入檔案，或貼上圖片'} value={input} rows={1} onChange={event=>setInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();if(workingRef.current)safe(()=>interruptAndSend());else safe(()=>send());}}}/>{importing&&<div className="attachment-import-status" role="status">正在加入圖片…</div>}<div className="composer-tools"><div className="composer-left"><div className="popover-anchor"><button className={`icon-btn attach-button ${attachMenu?'active':''}`} title="新增附件" aria-label="新增附件" aria-expanded={attachMenu} onClick={()=>setAttachMenu(!attachMenu)}><Glyph name="plus" size={23}/></button>{attachMenu&&<div className="popup-menu attachment-menu"><button onClick={()=>safe(()=>chooseFiles())}><Glyph name="upload"/>上傳檔案或圖片<span className="menu-trailing">從電腦選取</span></button><button onClick={()=>{setPicker(true);setAttachMenu(false);}}><Glyph name="library"/>從檔案庫加入</button><div className="menu-divider"/><button onClick={()=>{setPage('apps');setAttachMenu(false);}}><Glyph name="apps"/>應用程式與外掛</button><button onClick={()=>{setPage('computer');setAttachMenu(false);}}><Glyph name="computer"/>電腦與瀏覽器工具</button></div>}</div>{agent==='claude'&&runtime?.commands?.length&&<div className="popover-anchor"><button className="composer-tool-label" aria-label="Claude 原生指令與 Skills" onClick={()=>setCommandMenu(!commandMenu)}>／指令</button>{commandMenu&&<div className="popup-menu native-command-menu">{runtime.commands.map(command=><button key={command.name} onClick={()=>{setInput('/'+command.name+' ');setCommandMenu(false);composerRef.current?.focus();}}><b>/{command.name}</b><small>{command.description}</small></button>)}</div>}</div>}<button className={`composer-tool-label ${collabMode?'active':''}`} title="讓 Codex 與 Claude 自動多輪討論" aria-pressed={collabMode} onClick={()=>setCollabMode(value=>{const next=!value;if(next&&attachments.length){setAttachments([]);notify('已移除附件：雙 Agent 自動討論採純文字模式。');}return next;})}><Glyph name="spark" size={16}/>雙 Agent</button>{collabMode&&<label className="collab-rounds" title="每輪包含 Codex 與 Claude 各一次回應，最後再由主 Agent 綜合"><span>輪數</span><select aria-label="雙 Agent 討論輪數" value={collabRounds} disabled={!!working||connecting} onChange={event=>setCollabRounds(Number(event.target.value))}>{Array.from({length:8},(_,index)=>index+1).map(round=><option key={round} value={round}>{round}</option>)}</select></label>}<button className="composer-tool-label" title="管理對話工具" onClick={()=>setPage('apps')}><Glyph name="bolt" size={16}/>工具</button></div><div className="composer-right">{working?<button className="send-button stop-button" aria-label="停止回覆" title="停止回覆" onClick={()=>safe(cancelWork)}><Glyph name="stop" size={16}/></button>:<button className="send-button" disabled={importing||runtimeBusy||(!input.trim()&&!attachments.length)} aria-label="傳送訊息" title="傳送訊息（Enter）" onClick={()=>safe(()=>send())}><Glyph name="up" size={21}/></button>}</div></div></div>{runtime&&!runtimeReadiness(runtime).ready&&<RuntimeReadinessNotice runtime={runtime} busy={runtimeBusy} onRefresh={()=>safe(refreshRuntime)} onSettings={()=>openSettings('connection')}/>}<div className="composer-footnote">{collabMode?<><span>雙 Agent：Codex ↔ Claude</span> · {collabRounds} 輪 · {collabRounds*2+1} 次模型回合 · 純文字，工具停用</>:agent==='codex'?(runtime?<><span>Runtime：{runtime.hostName}</span> · {runtime.capabilities.localTools?'工具與工作目錄：這台 Mac':'Mac 工具尚未就緒'}</>:<><button onClick={()=>{setConnectionMode('runtime');openSettings('connection');}}>連接 Codex Runtime</button> · 檔案與歷史紀錄保留在這台 Mac</>):runtime?<><span>{runtime.authMode==='official'?'Claude 官方帳號':'Claude API'}</span> · 工具與工作目錄：這台 Mac</>:<><button onClick={()=>openSettings('connection')}>連接朋友的 Claude Runtime</button> · 原生工具自動選用</>}</div>{!current&&<div className="suggestions">{[['code','一起寫程式','幫我規劃並實作一個應用程式，先和我確認需求。'],['file','整理文件','請協助我整理附件內容，列出重點與下一步。'],['search','探索一個主題','請幫我研究一個主題，先詢問我想了解什麼。'],['computer','處理日常工作','請協助我規劃今天的工作，先了解我的待辦事項。']].map(([icon,label,prompt])=><button key={label} onClick={()=>{setInput(prompt);composerRef.current?.focus();}}><Glyph name={icon} size={17}/>{label}</button>)}</div>}</div></div>
        </div>}
        {page==='library'&&<section className="page-shell"><div className="page-heading"><div><span className="page-eyebrow">你的工作素材</span><h1>檔案庫</h1><p>上傳、整理，再把需要的檔案帶進對話。</p></div><button className="primary" onClick={()=>safe(()=>chooseFiles(false))}><Glyph name="plus" size={18}/>上傳檔案</button></div><div className="page-toolbar"><label className="search-field"><Glyph name="search" size={18}/><input aria-label="搜尋檔案" placeholder="搜尋檔案…" value={fileSearch} onChange={event=>setFileSearch(event.target.value)}/></label><div className="segmented"><button className={libraryMode==='grid'?'active':''} onClick={()=>setLibraryMode('grid')} aria-label="格狀檢視"><Glyph name="apps" size={17}/></button><button className={libraryMode==='list'?'active':''} onClick={()=>setLibraryMode('list')} aria-label="列表檢視"><Glyph name="library" size={17}/></button></div></div>{shownFiles.length?<><div className="results-meta">{shownFiles.length} 個檔案<span>本機檔案庫</span></div><div className={`library-grid ${libraryMode==='list'?'list-layout':''}`}>{shownFiles.map(file=>fileCard(file))}</div></>:<div className="library-empty"><div className="empty-symbol"><Glyph name="library" size={32}/></div><h2>{fileSearch?'找不到相符的檔案':'給想法，一點素材'}</h2><p>{fileSearch?'試試其他檔名。':'文件、圖片、程式碼，都可以從這裡加入。\n也可以直接把檔案拖進視窗。'}</p>{!fileSearch&&<button className="secondary" onClick={()=>safe(()=>chooseFiles(false))}><Glyph name="upload" size={17}/>選擇檔案</button>}</div>}<div className="page-note"><Glyph name="shield" size={16}/>檔案會複製到本機檔案庫。Codex 透過 Mac 工具讀取附件，圖片內容會傳給模型分析；舊版 SSH 對話會將附件上傳到遠端。</div></section>}
        {page==='usage'&&<UsagePage claudeQuota={claudeQuota} claudeConnected={!!connections.claude} claudeAuthMode={connections.claude?.authMode} quota={quota} baseline={quotaBaseline} records={usageRecords} hostKey={connections.codex?.hostKey} hostName={connections.codex?.hostName} busy={quotaBusy||claudeQuotaBusy} onRefresh={()=>{void refreshQuota();void refreshClaudeQuota();}} onConnect={()=>{setAgent('codex');openSettings('connection');}}/>}
        {page==='apps'&&<section className="page-shell"><div className="page-heading"><div><span className="page-eyebrow">為你的 Agent 增添能力</span><h1>應用程式與外掛</h1><p>在同一個地方查看 MCP、Skills 與 Plugins。</p></div><button className="secondary" onClick={()=>safe(refreshExtensions)} disabled={loadingExtensions}><Glyph name="refresh" size={17}/>{loadingExtensions?'讀取中…':'重新整理'}</button></div><div className="page-note"><Glyph name="link" size={17}/><span>Composio 在這台 Mac 登入，Codex 與 Claude 共用 Mac 工具通道。</span><button className="secondary compact" onClick={()=>safe(async()=>{const result=await api().extensions.loginMcp("local:codex:mcp:composio");notify(result.opened?"請在這台 Mac 的瀏覽器完成 Composio 登入；完成後重新連接 Agent。":"Mac Composio 已授權，請重新連接 Agent。");})}>在 Mac 登入 Composio</button></div><div className="extension-toolbar"><div className="tab-bar" role="tablist">{([['all','全部'],['plugin','Plugins'],['mcp','MCP'],['skill','Skills']] as const).map(([key,label])=><button role="tab" aria-selected={extensionTab===key} className={extensionTab===key?'active':''} key={key} onClick={()=>setExtensionTab(key)}>{label}<span>{extensions.filter(item=>item.agent===agent&&(key==='all'||item.kind===key)).length}</span></button>)}</div><label className="search-field compact-search"><Glyph name="search" size={17}/><input aria-label="搜尋擴充" placeholder="搜尋擴充…" value={extensionSearch} onChange={event=>setExtensionSearch(event.target.value)}/></label></div><div className="extension-source-bar"><span><i className="connection-dot online"/>本機設定{session&&' ＋ 遠端工作站'}</span><button className="text-button" onClick={()=>session?setExtensionManager(true):openSettings('connection')}>{session?'管理遠端擴充':'連線以查看遠端擴充'}<Glyph name="arrow" size={15}/></button></div>{shownExtensions.length?<div className="extensions-grid">{shownExtensions.slice(0,extensionLimit).map(item=><div className="extension-card" key={item.id}><div className={`extension-avatar ${item.kind}`}><Glyph name={item.kind==='mcp'?'link':item.kind==='skill'?'bolt':'apps'} size={24}/></div><div className="extension-card-content"><h3 title={item.name}>{item.name}</h3><p>{item.description||`${item.agent==='codex'?'Codex':'Claude Code'} ${item.kind==='mcp'?'工具伺服器':item.kind==='skill'?'工作技能':'外掛套件'}`}</p><div className="extension-badges"><span>{item.kind.toUpperCase()}</span><span>{item.source==='local'?'本機':'遠端'}</span><span className={item.status==='running'?'status-running':''}>{item.status==='running'||item.status==='connected'?'服務執行中':item.status==='loaded'?'原生已載入':item.status==='configured'?'已設定':item.status==='disabled'?'未啟用':item.status==='discovered'?'已找到':'已安裝'}</span></div></div></div>)}</div>:<div className="library-empty"><div className="empty-symbol"><Glyph name="apps" size={30}/></div><h2>{loadingExtensions?'正在讀取擴充…':extensionSearch?'找不到相符的擴充':'這裡還沒有擴充'}</h2><p>已安裝的擴充與工具設定會顯示在這裡。</p></div>}{shownExtensions.length>extensionLimit&&<div className="load-more"><span>已顯示 {extensionLimit} / {shownExtensions.length} 項</span><button className="secondary" onClick={()=>setExtensionLimit(limit=>limit+60)}>載入更多</button></div>}<div className="page-note"><Glyph name="info" size={17}/>「已設定」表示找到設定檔；帳號授權與工具連線仍由對應 Agent 驗證。目前顯示所選 Agent 的擴充；實際載入狀態以對話 Runtime 回報為準。</div>{extensionWarnings.length>0&&<details className="discovery-warnings"><summary>探索狀態（{extensionWarnings.length}）</summary>{extensionWarnings.map((warning,i)=><p key={i}>{warning}</p>)}</details>}</section>}
        {page==='history'&&<section className="page-shell"><div className="page-heading"><div><h1>歷史紀錄</h1><p>找回靈感，接續每一段對話。</p></div><button className="secondary" onClick={exportChats}><Glyph name="export" size={16}/>匯出</button></div><div className="page-toolbar"><label className="search-field"><Glyph name="search" size={18}/><input aria-label="搜尋歷史紀錄" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜尋標題與訊息…"/></label><div className="segmented"><button className={historyMode==='active'?'active':''} onClick={()=>setHistoryMode('active')}>全部對話</button><button className={historyMode==='archived'?'active':''} onClick={()=>setHistoryMode('archived')}>已封存</button></div></div><div className="history-list">{searchChats.sort((a,b)=>b.updatedAt-a.updatedAt).map(chat=><div className="history-row context-anchor" key={chat.id}><button onClick={()=>openChat(chat)}><Glyph name={chat.pinned?'pin':'chat'}/><span><b>{chat.title}</b><small>{chat.messages.find(message=>message.role==='user')?.text.slice(0,100)}</small></span><time>{dateLabel(chat.updatedAt)}</time></button><button className="icon-btn" aria-label={`${chat.title} 選單`} onClick={()=>setChatMenu(chatMenu===`history:${chat.id}`?null:`history:${chat.id}`)}><Glyph name="more"/></button>{chatMenu===`history:${chat.id}`&&conversationMenu(chat)}</div>)}{!searchChats.length&&<div className="library-empty"><Glyph name="history" size={34}/><h2>{search?'沒有相符的對話':historyMode==='archived'?'沒有已封存的對話':'你的故事，從下一句開始'}</h2><p>傳送第一則訊息後，對話會自動儲存在這裡。</p><button className="secondary" onClick={startNew}>開始新對話</button></div>}</div></section>}
        {page==='project'&&currentProject&&<section className="page-shell"><div className="page-heading"><div><span className="page-eyebrow"><Glyph name="folder" size={20}/>專案</span><h1>{currentProject.name}</h1><p>把相關對話整理在同一個地方。</p></div><div className="inline-actions"><button className="secondary" onClick={()=>setRename({kind:'project',id:currentProject.id,value:currentProject.name})}>重新命名</button><button className="primary" onClick={startNew}><Glyph name="plus" size={17}/>新對話</button></div></div><div className="project-chat-list">{chats.filter(chat=>chat.projectId===currentProject.id&&!chat.archived).map(chat=><button key={chat.id} onClick={()=>openChat(chat)}><Glyph name="chat"/><span><b>{chat.title}</b><small>{dateLabel(chat.updatedAt)}</small></span><Glyph name="arrow" size={17}/></button>)}</div>{!chats.some(chat=>chat.projectId===currentProject.id&&!chat.archived)&&<div className="library-empty"><Glyph name="folder" size={36}/><h2>讓這個專案開始運轉</h2><p>開始新的對話，或從歷史紀錄將對話移到此專案。</p><button className="secondary" onClick={startNew}>開始專案對話</button></div>}<div className="page-note"><Glyph name="info" size={16}/>專案用於本機對話分組。每段對話保有自己的內容，不會自動共用上下文。</div></section>}
        {page==='remote'&&(runtime?.transport==='https-relay'?<RelayFiles profile={{id:runtime.profileId,relayUrl:runtime.relayUrl}}/>:session?<FilesView session={session}/>:noConnection('遠端檔案，隨手可及','連接工作站後，就能瀏覽、上傳與下載遠端檔案。你的本機檔案庫隨時可用。'))}
        {page==='computer'&&<MacToolsPanel computerProvider={computerProvider} onProvider={chooseComputerProvider} services={services} exposure={httpExposure} httpHealth={httpHealth} onHttp={httpToolAction} runtime={runtime} doctor={doctor} permissionDiagnostics={permissionDiagnostics} onDiagnostics={()=>safe(async()=>{setPermissionDiagnostics('正在比對權限來源…');const result=await api().local.permissionDiagnostics();const value=(v:unknown)=>v===true?'已授權':v===false?'未授權':'未回報';setPermissionDiagnostics(`App 本身：輔助使用 ${value(result.app.accessibility)}、螢幕 ${result.app.screenRecording}。原生工具跟隨 App：輔助使用 ${value(result.attached.accessibility)}、螢幕 ${value(result.attached.screenRecording)}。原生工具獨立程序：輔助使用 ${value(result.detached.accessibility)}、螢幕 ${value(result.detached.screenRecording)}。App PID ${result.attached.process.parentPid}；跟隨工具 PID ${result.attached.process.pid}；獨立工具 PID ${result.detached.process.pid}。`);})} localTools={standaloneTools} toolHealth={toolHealth} busy={!!working||toolsBusy} onHealth={()=>checkToolHealth()} onRecover={recoverTools} onPermissions={()=>safe(async()=>{await api().local.requestPermissions();await refreshLocal();})} onConnect={()=>{setConnectionMode('runtime');openSettings('connection');}} onRefresh={()=>safe(async()=>{await refreshLocal();if(runtimeRef.current)await refreshRuntime();})} onPrompt={prompt=>{setPage('chat');setInput(prompt);requestAnimationFrame(()=>composerRef.current?.focus());}}/>}
        {page==='terminal'&&(runtime?.transport==='https-relay'?<RelayTerminal profile={{id:runtime.profileId,relayUrl:runtime.relayUrl}}/>:session?<div className="terminal-page"><div className="terminal-toolbar"><span><Glyph name="terminal"/>{agent==='codex'?'Codex':'Claude Code'} · {session.profile.name}</span><button className="secondary compact" onClick={()=>setTerminalKey(value=>value+1)}><Glyph name="refresh" size={15}/>重開終端機</button></div><div className="terminal-surface"><TerminalPane key={terminalKey+agent} sessionId={session.sessionId} agent={agent}/></div><p className="terminal-caption">互動式遠端終端機 · CLI 登入與進階操作</p></div>:noConnection('你的遠端終端機','連接工作站，在這裡使用 Codex 或 Claude Code 的完整命令列功能。'))}
      </div>
    </main>
    {settings&&<Modal title="設定" close={()=>setSettings(null)} className="settings-modal"><div className="settings-layout"><nav className="settings-nav">{settingsNav.map(([key,icon,label])=><button key={key} className={settings===key?'active':''} onClick={()=>setSettings(key)}><Glyph name={icon} size={18}/>{label}</button>)}</nav><div className="settings-body">
      {settings==='general'&&<><h3>一般</h3><div className="setting-row"><div><b>外觀</b><p>選擇適合你的工作環境。</p></div><select aria-label="外觀" value={theme} onChange={event=>setTheme(event.target.value as typeof theme)}><option value="system">跟隨系統</option><option value="light">淺色</option><option value="dark">深色</option></select></div><div className="setting-row"><div><b>減少動態效果</b><p>減少介面切換與移動動畫。</p></div><button role="switch" aria-checked={reduceMotion} aria-label="減少動態效果" className={`toggle ${reduceMotion?'on':''}`} onClick={()=>setReduceMotion(!reduceMotion)}><span/></button></div><div className="setting-row"><div><b>預設 Agent</b><p>選擇朋友主機上的 Codex 或 Claude Code。</p></div><select aria-label="預設 Agent" value={agent} disabled={!!working||!!current} onChange={event=>setAgent(event.target.value as Agent)}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></div><div className="setting-row"><div><b>語言</b><p>應用程式介面語言。</p></div><span>繁體中文</span></div><div className="setting-row vertical"><label htmlFor="custom-instructions"><b>自訂指令</b><p>這段文字會以使用者訊息形式加入每次對話，告訴 Agent 你的偏好與回覆風格。</p></label><textarea id="custom-instructions" rows={4} placeholder="例如：請用繁體中文簡短回答，先確認需求再動手。" value={customInstructions} onChange={event=>setCustomInstructions(event.target.value)}/><div className="setting-row-footnote"><span>已儲存到這台 Mac，所有新對話生效</span><button className="secondary compact" disabled={!customInstructions.trim()} onClick={()=>setCustomInstructions('')}>清除</button></div></div><div className="setting-row"><div><b>回覆結束時朗讀</b><p>Agent 完成回覆後自動朗讀最後一則訊息（zh-TW 語音）。</p></div><button role="switch" aria-checked={ttsEnabled} aria-label="回覆結束時朗讀" className={`toggle ${ttsEnabled?'on':''}`} onClick={()=>setTtsEnabled(!ttsEnabled)}><span/></button></div><div className="setting-row"><div><b>桌面通知</b><p>視窗不在前景時，Agent 完成回覆會發出 macOS 通知。</p></div><button role="switch" aria-checked={desktopNotifications} aria-label="桌面通知" className={`toggle ${desktopNotifications?'on':''}`} onClick={()=>setDesktopNotifications(!desktopNotifications)}><span/></button></div></>}
      {settings==='connection'&&<><h3>Agent 模式與工作環境</h3><NetworkSettings key={draft.id} draft={draft} setDraft={setDraft} busy={connecting||!!working} onSave={()=>safe(saveProfile)}/>{connectionError&&<p role="alert" className="settings-error">{connectionError}</p>}<div className="setting-row"><div><b>開啟 App 自動連線</b><p>預設關閉，舊對話可直接查看。開啟後會讀取已儲存的連線憑證，macOS 可能要求解鎖鑰匙圈。</p></div><button role="switch" aria-label="開啟 App 自動連線" aria-checked={autoConnect} className={`toggle ${autoConnect?'on':''}`} onClick={()=>setAutoConnect(!autoConnect)}><span/></button></div><div className="segmented provider-modes">{(['codex','claude'] as const).map(provider=><button key={provider} disabled={!!working||connecting} className={agent===provider?'active':''} onClick={()=>{setAgent(provider);if(current?.agent!==provider)startNew();}}>{provider==='codex'?'Codex':'Claude Code'}</button>)}</div><div className="device-picker"><label>連接設備<select aria-label="連接設備" value={profiles.some(profile=>profile.id===draft.id)?draft.id:''} disabled={connecting||!!working} onChange={event=>safe(()=>chooseDevice(profiles.find(profile=>profile.id===event.target.value)))}>{!profiles.some(profile=>profile.id===draft.id)&&<option value="">尚未儲存的新設備</option>}{profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name} · {profile.networkMode==='relay'?profile.relayUrl:`${profile.username}@${profile.host}`}
</option>)}</select></label><button className="secondary compact" disabled={connecting||!!working} onClick={()=>safe(()=>chooseDevice())}><Glyph name="plus" size={15}/>新增設備</button>{profiles.some(profile=>profile.id===draft.id)&&<button className="icon-btn" disabled={connecting||!!working} aria-label="移除目前儲存的設備" title="移除目前儲存的設備" onClick={()=>safe(async()=>{const id=draft.id;await chooseDevice();setProfiles(await api().profiles.delete(id));})}><Glyph name="trash" size={16}/></button>}</div>{agent==='claude'?<ClaudeSettings mode={claudeAuthMode} setMode={mode=>safe(async()=>{if(runtime){await api().claude.disconnect(runtime.runtimeId);setRuntime(null);runtimeRef.current=null;}setClaudeAuthMode(mode);setClaudeApiKey('');})} runtime={runtime} busy={connecting} working={!!working} onDisconnect={()=>safe(async()=>{manualDisconnect.current=true;setRecovering(false);await api().claude.disconnect(runtime!.runtimeId);setRuntime(null);})} onRefresh={()=>safe(refreshRuntime)} runtimeBusy={runtimeBusy} baseUrl={claudeBaseUrl} setBaseUrl={setClaudeBaseUrl} apiKey={claudeApiKey} setApiKey={setClaudeApiKey} model={claudeApiModel} setModel={setClaudeApiModel} autoCompactPercent={claudeAutoCompactPercent} setAutoCompactPercent={setClaudeAutoCompactPercent} executable={claudeExecutable} setExecutable={setClaudeExecutable} nodeExecutable={claudeNodeExecutable} setNodeExecutable={setClaudeNodeExecutable} remoteCwd={claudeRemoteCwd} setRemoteCwd={setClaudeRemoteCwd} configDir={draft.claudeConfigDir||''} setConfigDir={value=>setDraft((previous:any)=>({...previous,claudeConfigDir:value}))} localCwd={localCwd} setLocalCwd={setLocalCwd} chooseLocal={()=>safe(async()=>{const chosen=await api().runtime.chooseLocalDirectory();if(chosen)setLocalCwd(chosen);})} platform={runtimePlatform} setPlatform={selectRuntimePlatform} permission={permissionMode} setPermission={selectPermission} draft={draft} setDraft={setDraft} onSave={()=>safe(saveProfile)} onConnect={()=>safe(()=>connectClaude())}/>:<><div className="segmented connection-mode"><button className={connectionMode==='runtime'?'active':''} onClick={()=>setConnectionMode('runtime')}>Codex Runtime</button><button className={connectionMode==='ssh'?'active':''} onClick={()=>setConnectionMode('ssh')}>舊版 SSH 工具</button></div>
      {connectionMode==='runtime'?<><div className="runtime-role-grid"><div><Glyph name="computer" size={20}/><b>朋友的電腦</b><p>Codex Runtime<br/>ChatGPT 登入與模型連線</p></div><Glyph name="link" size={18}/><div><Glyph name="folder" size={20}/><b>這台 Mac</b><p>介面、檔案、工作目錄<br/>本機工具通道</p></div></div><p className="settings-intro">朋友在自己的 Windows 上登入 Codex。這裡透過 SSH 或 HTTPS 連接 Runtime，不需要填入 API Key；本機工具通道確認就緒後，才會開始對話。</p>
      {runtime&&<><RuntimeStatus runtime={runtime} onRefresh={()=>safe(refreshRuntime)} busy={runtimeBusy}/><button className="text-button runtime-disconnect" disabled={!!working||connecting} onClick={()=>safe(async()=>{manualDisconnect.current=true;setRecovering(false);await engineApi().disconnect(runtime.runtimeId);runtimeRef.current=null;setRuntime(null);setRuntimeRequests([]);notify('Runtime 已中斷');})}>中斷 Runtime 連線</button></>}
      <div className="runtime-configuration"><label>Runtime 主機系統<select aria-label="Runtime 主機系統" value={runtimePlatform} disabled={connecting} onChange={event=>selectRuntimePlatform(event.target.value as RuntimePlatform)}><option value="auto">自動辨識（建議）</option><option value="windows">Windows（原生 PowerShell）</option><option value="posix">macOS / Linux / WSL（POSIX）</option></select></label><label>Codex 執行檔<input aria-label="Codex 執行檔" value={runtimeExecutable} onChange={event=>setRuntimeExecutable(event.target.value)} placeholder="codex"/><small>{runtimePlatform==='windows'?'SSH 帳號的 PowerShell 必須能找到 codex。':'使用該 SSH 帳號可執行的 codex 指令或絕對路徑。'}</small></label><label>上下文自動壓縮<select aria-label="Codex 上下文自動壓縮" value={codexAutoCompactPercent} disabled={connecting} onChange={event=>setCodexAutoCompactPercent(Number(event.target.value))}><option value={60}>積極 · 60%</option><option value={70}>提早 · 70%（建議）</option><option value={80}>平衡 · 80%</option><option value={95}>接近原生 · 95%</option></select><small>到達所選上下文比例時，要求 Codex 提早自動壓縮；預設 70%，避免長對話突然撞滿。</small></label></div></>:<p className="settings-intro">此模式保留 SFTP、遠端終端機與 Claude Code。這些工具會在 SSH 主機執行，與上方「Codex Runtime ＋ Mac 工具」分開管理。</p>}
      {connectionMode==='ssh'&&session&&<div className="connected-banner"><span><i className="connection-dot online"/>SSH 已連線至 {session.profile.name}</span><button className="text-button" disabled={!!working||connecting} onClick={()=>safe(async()=>{await api().ssh.disconnect(session.sessionId);setSession(null);notify('SSH 已中斷連線');})}>中斷連線</button></div>}

      <ConnectionForm draft={draft} setDraft={setDraft} onSave={()=>safe(saveProfile)} onConnect={()=>safe(()=>connectionMode==='runtime'?connectRuntime():connect())} busy={connecting||!!working} connectLabel={connectionMode==='runtime'?'連接 Runtime':'連接 SSH'}/>
      {connectionMode==='runtime'&&<><div className="runtime-local-folder"><h4>這台 Mac 的工作目錄</h4><p>選擇 Agent 將使用的本機資料夾。這不是朋友電腦上的路徑。</p><div className="inline-field"><input aria-label="Mac 工作目錄" value={localCwd} onChange={event=>setLocalCwd(event.target.value)} placeholder="選擇這台 Mac 的資料夾" disabled={!!working||connecting}/><button className="secondary compact" disabled={!!working||connecting} onClick={()=>safe(async()=>{if(!api().runtime?.chooseLocalDirectory){notify('請重新啟動更新後的 App。');return;}const chosen=await api().runtime.chooseLocalDirectory();if(chosen)setLocalCwd(chosen);})}><Glyph name="folder" size={16}/>選擇</button></div></div>{runtime&&<div className="runtime-model-settings"><h4>Runtime 提供的模型</h4><select aria-label="Runtime 模型" value={runtimeModel} disabled={!!working||!runtime.models.length} onChange={event=>{setRuntimeModel(event.target.value);setRuntimeEffort(runtime.models.find(model=>model.id===event.target.value)?.defaultReasoningEffort||'');}}>{!runtime.models.length&&<option value="">尚未取得模型清單</option>}{runtime.models.map(model=><option key={model.id} value={model.id}>{model.displayName||model.id}</option>)}</select>{reasoningOptions(runtime.models.find(model=>model.id===runtimeModel)).length>0&&<label>推理程度<select aria-label="推理程度" value={runtimeEffort} disabled={!!working||connecting} onChange={event=>setRuntimeEffort(event.target.value)}>{reasoningOptions(runtime.models.find(model=>model.id===runtimeModel)).map(effort=><option key={effort} value={effort}>{effort}</option>)}</select></label>}</div>}</>}
      {connectionMode==='runtime'&&<div className="runtime-permissions"><h4>Mac 工具權限</h4><select aria-label="Mac 工具權限" disabled={connecting} value={permissionMode} onChange={event=>selectPermission(event.target.value as 'ask'|'project'|'full')}><option value="project">讀取專案可自動執行；操作前詢問</option><option value="ask">檔案擴充、電腦與瀏覽器操作先詢問</option><option value="full">最高權限：所有操作不逐次詢問</option></select><p>{permissionMode==='full'?'最高權限會允許工作資料夾以外的檔案、命令與應用程式操作，不逐次詢問。需要管理員權限的讀取可由 macOS 系統視窗授權；完整磁碟存取、SIP 與磁碟本身權限仍適用。設定會保留並立即套用。':'檔案擴充、點擊與瀏覽器操作依此設定詢問。命令由 Codex 權限規則核准，部分唯讀命令可自動執行。'}</p></div>}<div className="settings-tip">{connectionMode==='runtime'?'帳號與方案由 Runtime 實際回報。登入憑證留在朋友的電腦；未確認本機工具可用時，不會退回朋友電腦執行工作。':'首次登入請在遠端終端機完成。SSH 連線資料與 Agent 帳號分開管理。'}</div></>}</>}
      {settings==='data'&&<><h3>資料與儲存</h3><div className="setting-row"><div><b>對話紀錄</b><p>{chats.length} 段對話 · {projects.length} 個專案，儲存於這台 Mac。</p></div><button className="secondary compact" onClick={exportChats}>匯出資料</button></div><div className="setting-row"><div><b>封存的對話</b><p>{chats.filter(chat=>chat.archived).length} 段已封存的對話。</p></div><button className="secondary compact" onClick={()=>{setHistoryMode('archived');setPage('history');setSettings(null);}}>管理</button></div><div className="setting-row"><div><b>檔案庫</b><p>{library.length} 個檔案。移除項目不會刪除原始檔。</p></div><button className="secondary compact" onClick={()=>{setPage('library');setSettings(null);}}>開啟</button></div><div className="settings-tip"><Glyph name="shield" size={20}/><p>對話內容保存在本機。傳送訊息時，內容與所選附件資訊會交給 Runtime 與模型服務。Codex 模式的工作檔案保留在 Mac；舊版 SSH 模式會上傳附件。</p></div></>}
      {settings==='shortcuts'&&<><h3>鍵盤快捷鍵</h3>{[['新對話','⇧ ⌘ N'],['臨時對話','⌘ T'],['提示範本','⇧ ⌘ U'],['搜尋對話','⌘ K'],['在目前對話中尋找','⌘ F'],['開啟新視窗','⌘ U'],['展開／收合側邊欄','⌘ B'],['開啟設定','⌘ ,'],['傳送訊息','Enter'],['訊息換行','Shift + Enter'],['關閉對話框','Esc']].map(([label,key])=><div className="setting-row" key={label}><b>{label}</b><kbd>{key}</kbd></div>)}</>}
      {settings==='advanced'&&<><h3>進階工具</h3><p className="settings-intro">遠端登入回呼、本機網路與執行環境檢查。</p><SettingsView session={session} doctor={doctor} addresses={addresses}/><button className="secondary" onClick={()=>safe(refreshLocal)}><Glyph name="refresh" size={16}/>重新檢查環境</button></>}
      {settings==='about'&&<div className="about-settings"><div className="about-logo"><Glyph name="spark" size={36}/></div><h3>AgentBridge Studio</h3><p>你的想法，與 Agent 之間。</p><span className="version-pill">桌面工作空間 · 0.4</span><div className="about-features"><p>支援遠端 Codex 與 Claude Code 對話、檔案庫、歷史紀錄、擴充探索，以及電腦與瀏覽器工具。</p><p>這是獨立的 Agent 用戶端。可使用 Runtime 主機上已登入的 ChatGPT 帳號。ChatGPT 雲端對話同步、語音與圖像生成尚未接入。</p></div></div>}
    </div></div></Modal>}
    {hostConfirmation&&<Modal title={hostConfirmation.hostChanged?'Runtime 主機金鑰已變更':'確認 Runtime 主機'} close={()=>{if(!connecting){setHostConfirmation(null);setSettings('connection');}}} className="small-modal"><div className="runtime-host-confirm"><p>{hostConfirmation.hostChanged?'這個位址回報的 SSH 主機金鑰和先前不同。請先向朋友核對新指紋，再決定是否連線。':'首次連線前，請向朋友核對這台設備的 SSH 主機金鑰指紋。'}</p><b>{hostConfirmation.payload.profile.username}@{hostConfirmation.payload.profile.host}</b><label>本次指紋<code>{hostConfirmation.hostFingerprint}</code></label>{hostConfirmation.previousFingerprint&&<label>先前指紋<code>{hostConfirmation.previousFingerprint}</code></label>}</div><div className="modal-actions"><button className="secondary" disabled={connecting} onClick={()=>{setHostConfirmation(null);setSettings('connection');}}>取消</button><button className="primary" disabled={connecting} onClick={()=>safe(()=>connectRuntime({...hostConfirmation.payload,trustedFingerprint:hostConfirmation.hostFingerprint}))}>{connecting?'連線中…':'已核對，信任此主機'}</button></div></Modal>}
    {searchOpen&&<Modal title="搜尋對話" close={()=>setSearchOpen(false)} className="search-modal"><label className="search-field large-search"><Glyph name="search"/><input autoFocus placeholder="搜尋所有對話的標題與內容…" aria-label="搜尋所有對話" value={search} onChange={event=>setSearch(event.target.value)}/><kbd>⌘ K</kbd></label><div className="search-results">{chats.filter(chat=>!chat.temporary&&(!search||chat.title.toLowerCase().includes(search.toLowerCase())||chat.messages.some(message=>message.text.toLowerCase().includes(search.toLowerCase())))).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,30).map(chat=><button key={chat.id} onClick={()=>openChat(chat)}><Glyph name="chat"/><span><b>{chat.title}</b><small>{chat.archived?'已封存 · ':''}{dateLabel(chat.updatedAt)} · {chat.agent==='codex'?'Codex':'Claude Code'}</small></span><Glyph name="arrow" size={16}/></button>)}{!chats.length&&<div className="compact-empty">還沒有對話。從新對話開始吧。</div>}{chats.length>0&&!chats.some(chat=>(!search||chat.title.toLowerCase().includes(search.toLowerCase())||chat.messages.some(message=>message.text.toLowerCase().includes(search.toLowerCase()))))&&<div className="compact-empty">找不到相符的對話。</div>}</div></Modal>}
    {rename&&<Modal title={rename.kind==='chat'?'重新命名對話':'重新命名專案'} close={()=>setRename(null)} className="small-modal"><form onSubmit={event=>{event.preventDefault();if(!rename.value.trim())return;if(rename.kind==='chat')patchChat(rename.id,{title:rename.value.trim()});else setProjects(prev=>prev.map(project=>project.id===rename.id?{...project,name:rename.value.trim()}:project));setRename(null);}}><label className="form-label">名稱<input autoFocus value={rename.value} maxLength={100} onChange={event=>setRename({...rename,value:event.target.value})}/></label><div className="modal-actions"><button type="button" className="secondary" onClick={()=>setRename(null)}>取消</button><button className="primary" disabled={!rename.value.trim()}>儲存</button></div></form></Modal>}
    {chatSearch!==null&&current&&<Modal title="在目前對話中尋找" close={()=>{setChatSearch(null);stopSpeaking();}} className="small-modal"><label className="search-field large-search"><Glyph name="search"/><input autoFocus aria-label="搜尋目前對話" placeholder="搜尋這段對話的訊息…" value={chatSearch} onChange={event=>{setChatSearch(event.target.value);setChatSearchIndex(0);}} onKeyDown={event=>{if(event.key==='Escape')event.stopPropagation();if(event.key==='ArrowDown'){event.preventDefault();jumpChatSearch(1);}if(event.key==='ArrowUp'){event.preventDefault();jumpChatSearch(-1);}}}/></label>{chatSearch.trim()&&<div className="search-results-meta">{chatSearchHits.length?`${Math.min(chatSearchIndex+1,chatSearchHits.length)} / ${chatSearchHits.length} 筆結果`:'沒有符合的訊息'}</div>}{chatSearch.trim()&&chatSearchHits.length>0&&<div className="chat-search-hits">{chatSearchHits.map((hit,hitIndex)=>{const chat=chats.find(item=>item.id===current.id);const message=chat?.messages.find(item=>item.id===hit.messageId);if(!message)return null;return <button key={`${hit.messageId}-${hit.matchStart}`} className={hitIndex===chatSearchIndex?'selected':''} onClick={()=>{setChatSearchIndex(hitIndex);jumpToMessage(current.id,hit.messageId);}}><b>{message.role==='user'?'我':current.agent==='codex'?'Codex':'Claude'}</b><span>{hit.excerpt}</span></button>;})}</div>}{!chatSearch.trim()&&<p className="dialog-copy">輸入關鍵字尋找這段對話中的訊息，可用 ↑ ↓ 切換結果。</p>}</Modal>}
    {editMessage&&<Modal title="編輯訊息並重新傳送" close={()=>setEditMessage(null)} className="small-modal"><p className="dialog-copy">編輯後，這則訊息之後的回覆會被移除，並以新內容重新傳送。</p><textarea className="edit-message-input" autoFocus aria-label="編輯訊息" value={editMessage.text} onChange={event=>setEditMessage(prev=>prev?{...prev,text:event.target.value}:prev)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void commitEditMessage();}}}/><div className="modal-actions"><button className="secondary" onClick={()=>setEditMessage(null)}>取消</button><button className="primary" disabled={!!working||!editMessage.text.trim()} onClick={()=>void commitEditMessage()}><Glyph name="up" size={16}/>重送</button></div></Modal>}
    {templateModal&&<Modal title="提示範本" close={()=>setTemplateModal(false)} className="small-modal">{templates.length>0&&<div className="template-list">{templates.map(template=><div key={template.id} className="template-item"><button className="template-body" onClick={()=>insertTemplate(template.body)}><b>{template.title}</b><span>{template.body.slice(0,90)}{template.body.length>90?'…':''}</span></button><button className="icon-btn tiny" title="刪除範本" aria-label={`刪除範本 ${template.title}`} onClick={()=>setTemplates(prev=>prev.filter(item=>item.id!==template.id))}><Glyph name="trash" size={15}/></button></div>)}</div>}<form className="template-form" onSubmit={event=>{event.preventDefault();const form=event.currentTarget;const titleInput=form.elements.namedItem('template-title') as HTMLInputElement;const bodyInput=form.elements.namedItem('template-body') as HTMLTextAreaElement;saveTemplate(titleInput.value,bodyInput.value);form.reset();}}><label>新增範本<input name="template-title" placeholder="範本標題（例如：程式碼審查）" maxLength={60}/></label><label>內容<textarea name="template-body" rows={3} placeholder="輸入要重複使用的提示內容…"/></label><button type="submit" className="primary">加入範本</button></form>{templates.length===0&&<p className="dialog-copy">範本會存在這台 Mac；點一下就能把內容帶入輸入框。</p>}</Modal>}
    {deleteChat&&<Modal title="刪除這段對話？" close={()=>setDeleteChat(null)} className="small-modal"><p className="dialog-copy">「{chats.find(chat=>chat.id===deleteChat)?.title}」會從這台 Mac 的歷史紀錄移除。這個動作無法復原。</p><div className="modal-actions"><button className="secondary" onClick={()=>setDeleteChat(null)}>取消</button><button className="danger" onClick={()=>{setChats(prev=>prev.filter(chat=>chat.id!==deleteChat));if(currentId===deleteChat)startNew();setDeleteChat(null);}}>刪除對話</button></div></Modal>}
    {projectModal&&<Modal title="建立專案" close={()=>setProjectModal(false)} className="small-modal"><form onSubmit={event=>{event.preventDefault();if(!projectName.trim())return;const id=crypto.randomUUID();setProjects(prev=>[...prev,{id,name:projectName.trim()}]);setProjectId(id);setProjectName('');setProjectModal(false);setPage('project');}}><label className="form-label">專案名稱<input autoFocus placeholder="例如：下一個好點子" value={projectName} maxLength={80} onChange={event=>setProjectName(event.target.value)}/></label><p className="dialog-copy">把同一個主題的對話收在一起。</p><div className="modal-actions"><button type="button" className="secondary" onClick={()=>setProjectModal(false)}>取消</button><button className="primary" disabled={!projectName.trim()}>建立專案</button></div></form></Modal>}
    {picker&&<Modal title="從檔案庫加入" close={()=>setPicker(false)} className="file-picker-modal"><label className="search-field"><Glyph name="search" size={17}/><input autoFocus placeholder="搜尋檔案…" aria-label="搜尋可加入的檔案" value={fileSearch} onChange={event=>setFileSearch(event.target.value)}/></label><div className="library-grid list-layout">{shownFiles.map(file=>fileCard(file,true))}</div>{!shownFiles.length&&<div className="compact-empty">{fileSearch?'找不到相符檔案':'檔案庫還沒有檔案'}</div>}<div className="modal-actions"><button className="secondary" onClick={()=>safe(async()=>{await chooseFiles();setPicker(false);})}><Glyph name="upload" size={17}/>從電腦上傳</button></div></Modal>}
    {extensionManager&&session&&<Modal title="管理遠端擴充" close={()=>setExtensionManager(false)} className="extension-modal"><ExtensionsView session={session}/></Modal>}
    {toast&&<div className="studio-toast" role="status"><Glyph name="info" size={17}/><span>{toast}</span><button className="icon-btn tiny" aria-label="關閉通知" onClick={()=>setToast(null)}><Glyph name="close" size={14}/></button></div>}
    {dragging&&<div className="studio-drop-overlay"><Glyph name="upload" size={44}/><h2>{page==='chat'?'加入這段對話':'加入檔案庫'}</h2><p>放開檔案，即可加入</p></div>}
  </motion.div></MotionConfig>;
}
export default App;
