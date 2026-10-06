import { useState } from 'react';
import { Glyph } from './StudioUI';

export interface RuntimeModel {
  id: string;
  displayName: string;
  supportedReasoningEfforts: Array<string | {reasoningEffort?:string; effort?:string; description?:string}>;
  defaultReasoningEffort?: string;
  isDefault?: boolean;
}
export interface RuntimeConnection {
  agent?: "codex"|"claude";
  authMode?:"official"|"api";
  runtimeLocation?:"remote"|"local";
  remoteCwd?:string;
  runtimeId: string;
  status: string;
  toolExecution: 'unavailable'|'local-code-mode'|'local-executor'|'local-mcp';
  account: {type:string;planType?:string;authenticated:boolean};
  models: RuntimeModel[];
  capabilities: {localTools:boolean;reason:string;fileShell?:boolean;macMcp?:boolean};
  runtimeVersion?: string;
  runtimePlatform?: string;
  connectionPlatform?: 'windows'|'posix';
  executorConnected?: boolean;
  executorVersion?: string;
  executorEnvironment?: {environmentId:string;cwd:string;shell:{name:string;path:string}};
  toolHostConnected?: boolean;
  localToolNames?: string[];
  permissionMode?: 'ask'|'project'|'full';
  diagnostic?: string;
  macTools?: {ok:boolean;tools:string[];computer:string;browser:string;unavailable?:string[]};
  commands?:Array<{name:string;description?:string;argumentHint?:string}>;
  localCwd?:string;
  hostName?: string;
  hostKey?: string;
}
export interface RuntimeRequest {
  approvalId: string;
  runtimeId: string;
  requestId: string;
  type: 'approval'|'userInput';
  executionLocation?: 'remote'|'local';
  title?: string;
  detail?: string;
  text?: string;
  questions?: Array<{id:string;header?:string;question:string;options?:Array<{label:string;description?:string}>;isOther?:boolean;isSecret?:boolean}>;
}
export const reasoningOptions=(model?:RuntimeModel):string[]=>model?.supportedReasoningEfforts?.map(value=>typeof value==='string'?value:value.reasoningEffort||value.effort||'').filter(Boolean)||[];

export function RuntimeStatus({runtime,onRefresh,busy}:{runtime:RuntimeConnection;onRefresh:()=>void;busy:boolean}) {
  const connected=runtime.status==='connected';
  return <div className="runtime-status-card">
    <div className="runtime-status-heading"><div><i className={`connection-dot ${connected?'online':''}`}/><b>{connected?'Runtime 已連線':'Runtime 已中斷'}</b></div><button className="icon-btn tiny" title="更新 Runtime 狀態" aria-label="更新 Runtime 狀態" disabled={busy} onClick={onRefresh}><Glyph name="refresh" size={16}/></button></div>
    <dl className="runtime-facts"><div><dt>登入方式</dt><dd>{runtime.agent==='claude'?(runtime.authMode==='official'?'Claude 官方帳號':'Claude API／現有供應商'):runtime.account?.type==='chatgpt'?'ChatGPT 登入':runtime.account?.type==='apiKey'?'API Key':runtime.account?.type||'尚未登入'}</dd></div><div><dt>帳號狀態</dt><dd>{runtime.account?.authenticated?'已登入':'尚未登入'}</dd></div><div><dt>帳號方案</dt><dd>{runtime.account?.planType||'Runtime 未提供'}</dd></div><div><dt>模型清單</dt><dd>{runtime.models?.length||0} 個模型選項</dd></div></dl>
    <dl className="runtime-facts"><div><dt>Runtime 版本</dt><dd>{runtime.runtimeVersion||'未提供'}</dd></div><div><dt>Mac 執行端</dt><dd>{runtime.executorConnected?'已連線 · 檔案與命令在 Mac 執行':'尚未連線'}</dd></div>{runtime.executorConnected&&runtime.executorEnvironment&&<div><dt>Mac 工作目錄</dt><dd>{runtime.executorEnvironment.cwd}</dd></div>}</dl>
    {runtime.macTools&&<dl className="runtime-facts"><div><dt>電腦操作</dt><dd>{runtime.macTools.computer.startsWith('connected')?'已接通 · 使用時檢查權限':'尚未可用'}</dd></div><div><dt>瀏覽器操作</dt><dd>{runtime.macTools.browser.startsWith('connected')?'已接通 · 使用時啟動瀏覽器':'尚未可用'}</dd></div><div><dt>Mac 工具</dt><dd>{runtime.macTools.tools.length} 個可用工具</dd></div><div><dt>連線</dt><dd>{runtime.agent==='claude'&&runtime.runtimeLocation==='local'?'Mac 原生程序':'SSH 加密通道'}</dd></div></dl>}{runtime.diagnostic&&<p className="runtime-request-error">{runtime.diagnostic}</p>}
    <div className={`runtime-capability ${runtime.capabilities.localTools?'ready':''}`}><Glyph name={runtime.capabilities.localTools?'check':'info'} size={18}/><div><b>{runtime.capabilities.localTools?'Mac 工具通道已就緒':'Mac 工具通道尚未就緒'}</b><p>{runtime.capabilities.reason||'等待 Runtime 確認本機工具能力。'}</p></div></div>
  </div>;
}

export function RuntimePendingRequest({request,onRespond,onCancel}:{request:RuntimeRequest;onRespond:(decision:'accept'|'decline',answers?:Record<string,string[]>)=>Promise<void>;onCancel:()=>Promise<void>}) {
  const [answers,setAnswers]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false);
  const [failure,setFailure]=useState('');
  const blockedApproval=request.type==='approval'&&request.executionLocation!=='local';
  const submit=async(decision:'accept')=>{
    setBusy(true);setFailure('');
    try{await onRespond(decision,request.type==='userInput'?Object.fromEntries((request.questions||[]).map(question=>[question.id,[answers[question.id]||'']])):undefined);}catch(error){setFailure(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  };
  const reject=async()=>{setBusy(true);setFailure('');try{await onRespond('decline');}catch(error){setFailure(error instanceof Error?error.message:String(error));}finally{setBusy(false);}};
  const cancel=async()=>{setBusy(true);setFailure('');try{await onCancel();}catch(error){setFailure(error instanceof Error?error.message:String(error));}finally{setBusy(false);}};
  return <section className="runtime-pending" role="region" aria-label={request.type==='userInput'?'Agent 等待你的回答':'Agent 等待核准'}>
    <div className="runtime-pending-title"><Glyph name={request.type==='userInput'?'chat':'shield'} size={19}/><div><b>{request.title||(request.type==='userInput'?'Agent 需要你的回答':'Agent 請求執行操作')}</b><span>{request.type==='userInput'?'回答後才會繼續':request.executionLocation==='remote'?'操作位置：Runtime 主機（朋友電腦）':request.executionLocation==='local'?'操作位置：這台 Mac':'請確認操作內容，尚未執行'}</span></div></div>
    {(request.detail||request.text)&&<pre className="runtime-request-detail">{request.detail||request.text}</pre>}
    {request.type==='userInput'&&(request.questions||[]).map(question=><fieldset className="runtime-question" key={question.id}><legend>{question.question}</legend>{question.options?.length?<div className="runtime-answer-options">{question.options.map(option=><label key={option.label}><input type="radio" name={request.approvalId+question.id} checked={answers[question.id]===option.label} onChange={()=>setAnswers(value=>({...value,[question.id]:option.label}))}/><span><b>{option.label}</b>{option.description&&<small>{option.description}</small>}</span></label>)}</div>:null}{(!question.options?.length||question.isOther)&&<input aria-label={`${question.header||question.question} 的回答`} type={question.isSecret?'password':'text'} placeholder="輸入你的回答" value={answers[question.id]||''} onChange={event=>setAnswers(value=>({...value,[question.id]:event.target.value}))}/>}</fieldset>)}
    {failure&&<p className="runtime-request-error" role="alert">{failure}</p>}
    {blockedApproval&&<p className="runtime-request-error" role="alert">操作位置尚未確認為這台 Mac，因此無法允許。</p>}
    <div className="runtime-request-actions"><button className="text-button" disabled={busy} onClick={cancel}>中斷這次回覆</button><div><button className="secondary compact" disabled={busy} onClick={reject}>拒絕</button><button className="primary compact" disabled={busy||blockedApproval||(request.type==='userInput'&&(request.questions||[]).some(question=>!answers[question.id]?.trim()))} onClick={()=>submit('accept')}>{busy?'處理中…':request.type==='userInput'?'提交回答':'允許這次操作'}</button></div></div>
  </section>;
}
