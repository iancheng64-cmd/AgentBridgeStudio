import {useEffect,useRef,useState} from 'react';
import {Glyph} from './StudioUI';
import type {AccountQuota} from '../main/quota-state';
import type {RuntimeConnection} from './RuntimeControls';
import type {ClaudeQuotaSummary, ClaudeQuotaWindow} from '../main/runtime-usage';

export const quotaWindowLabel=(minutes:number|null)=>minutes===null?'額度視窗':minutes>=1440?`${Math.round(minutes/1440*10)/10} 天額度`:`${Math.round(minutes/60*10)/10} 小時額度`;
const at=(seconds:number|null)=>{
  if(seconds===null)return '未提供';
  const ms=seconds>1e11?seconds:seconds*1000;
  return new Date(ms).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
};

export function QuotaPopover({
  activeAgent='codex',
  runtime,
  quota,
  claudeRuntime,
  claudeQuota,
  busy,
  onRefresh,
  onClaudeRefresh,
  onReport,
  onConnect
}:{
  activeAgent?:'codex'|'claude';
  runtime?:RuntimeConnection;
  quota?:AccountQuota;
  claudeRuntime?:RuntimeConnection;
  claudeQuota?:ClaudeQuotaSummary;
  busy:boolean;
  onRefresh:()=>void;
  onClaudeRefresh:()=>void;
  onReport:()=>void;
  onConnect:(target?:'codex'|'claude')=>void;
}){
  const [open,setOpen]=useState(false);
  const [tab,setTab]=useState<'codex'|'claude'>(activeAgent);
  const anchor=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement>(null);
  const close=()=>{setOpen(false);trigger.current?.focus();};

  useEffect(()=>{
    if(open)setTab(activeAgent);
  },[open,activeAgent]);

  useEffect(()=>{
    if(!open)return;
    panel.current?.focus();
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.stopPropagation();setOpen(false);trigger.current?.focus();}};
    const outside=(event:PointerEvent)=>{if(anchor.current&&!anchor.current.contains(event.target as Node))setOpen(false);};
    document.addEventListener('keydown',escape,true);document.addEventListener('pointerdown',outside);
    return()=>{document.removeEventListener('keydown',escape,true);document.removeEventListener('pointerdown',outside);};
  },[open]);

  const displayed=runtime?(quota?.available?quota:quota?.lastKnown):undefined;
  const stale=!!displayed&&!quota?.available;
  const account=runtime?.account;
  const codexAccountLabel=account?.type==='chatgpt'?`ChatGPT${account.planType?' · '+account.planType.toUpperCase():''}`:account?.type==='apiKey'?'API Key 帳戶':account?.type==='amazonBedrock'?'Amazon Bedrock':account?.authenticated?'Runtime 帳戶':'尚未登入';

  const claudeAccount=claudeRuntime?.account;
  const claudeAccountLabel=claudeRuntime?.authMode==='official'
    ?(claudeAccount?.authenticated?'Claude 官方登入 · 訂閱額度':'Claude 官方登入狀態尚未確認')
    :claudeRuntime?.authMode==='api'
      ?'API Key 模式 · 自訂供應商'
      :(claudeAccount?.authenticated?'Claude 帳戶已連線':'尚未連線');

  const isClaudeActive=activeAgent==='claude';

  // Prepare Claude windows with explicit 5-hour limit and 7-day limit guarantees
  const reportedClaudeWindows=claudeQuota?.windows||[];
  const fiveHourWindow=reportedClaudeWindows.find(w=>w.id==='five_hour');
  const sevenDayWindow=reportedClaudeWindows.find(w=>w.id==='seven_day');
  const otherClaudeWindows=reportedClaudeWindows.filter(w=>w.id!=='five_hour'&&w.id!=='seven_day');
  const displayClaudeWindows: Array<ClaudeQuotaWindow & { pendingNotice?: string }> = [
    fiveHourWindow
      ? { ...fiveHourWindow, name: '5 小時額度 (5 hour limit)' }
      : { id: 'five_hour', name: '5 小時額度 (5 hour limit)', windowDurationMins: 300, usedPercent: null, remainingPercent: null, resetsAt: null, pendingNotice: busy?'正在讀取額度…':claudeQuota?.error?'查詢未成功，請依上方說明處理後更新':'尚未取得額度；未提供不代表零' },
    sevenDayWindow
      ? { ...sevenDayWindow, name: '7 天額度 (7 day limit)' }
      : { id: 'seven_day', name: '7 天額度 (7 day limit)', windowDurationMins: 10080, usedPercent: null, remainingPercent: null, resetsAt: null, pendingNotice: busy?'正在讀取額度…':claudeQuota?.error?'查詢未成功，請依上方說明處理後更新':'尚未取得額度；未提供不代表零' },
    ...otherClaudeWindows
  ];

  return <div className="quota-anchor" ref={anchor}>
    <button
      ref={trigger}
      className={`quota-trigger ${open?'active':''}`}
      aria-label={isClaudeActive?'查看 Claude Code 帳戶剩餘用量':'查看 Codex 帳戶剩餘用量'}
      aria-expanded={open}
      aria-controls="agent-quota-popover"
      aria-haspopup="dialog"
      onClick={()=>{
        setOpen(!open);
        if(!open)(isClaudeActive?onClaudeRefresh:onRefresh)();
      }}
    >
      <Glyph name={isClaudeActive?'spark':'history'} size={16}/>
      <span>{isClaudeActive?'Claude Code 剩餘用量':'Codex 剩餘用量'}</span>
      <Glyph name="down" size={13}/>
    </button>
    {open&&<section ref={panel} tabIndex={-1} id="agent-quota-popover" role="dialog" aria-label="帳戶剩餘用量" className="quota-popover">
      <div className="quota-popover-heading">
        <div>
          <b>帳戶剩餘用量</b>
          <small>{tab==='claude'?(claudeRuntime?`Claude Code · ${claudeRuntime.hostName||'這台 Mac'}`:'Claude Code · 尚未連線'):(runtime?`Codex · ${runtime.hostName||'這台 Mac'}`:'Codex · 尚未連接 Runtime')}</small>
        </div>
        <button className="icon-btn tiny" aria-label="關閉剩餘用量" onClick={close}><Glyph name="close" size={16}/></button>
      </div>

      <div className="segmented" style={{margin:'10px 0 12px'}}>
        <button className={tab==='codex'?'active':''} onClick={()=>setTab('codex')}>Codex</button>
        <button className={tab==='claude'?'active':''} onClick={()=>{setTab('claude');onClaudeRefresh();}}>Claude Code</button>
      </div>

      {tab==='codex'?(
        <>
          {runtime?<><p className="quota-account">{codexAccountLabel}</p><button className="text-button quota-refresh" onClick={onRefresh} disabled={busy}><Glyph name="refresh" size={14}/>{busy?'讀取中…':'更新剩餘用量'}</button></>:<div className="quota-unavailable"><p>連接 Codex Runtime 後，從該 Runtime 的登入帳戶讀取剩餘用量。</p><button className="secondary compact" onClick={()=>{close();onConnect('codex');}}>連接 Codex Runtime</button></div>}
          {runtime&&quota?.error&&<p className="quota-unavailable" role="status">{quota.error}</p>}
          {stale&&<p className="quota-stale">以下為先前快照，並非目前剩餘用量。</p>}
          {runtime&&displayed?.buckets.filter(bucket=>bucket.primary||bucket.secondary).map(bucket=><div className={`quota-bucket ${stale?'stale':''}`} key={bucket.id}><h4>{bucket.name}</h4>{(['primary','secondary'] as const).map(kind=>{const window=bucket[kind];if(!window)return null;return <div className="quota-window" key={kind}><div><span>{quotaWindowLabel(window.windowDurationMins)}</span><strong>{window.remainingPercent===null?'未提供':`${Math.round(window.remainingPercent*10)/10}%`}<small>{window.remainingPercent===null?'':' 剩餘'}</small></strong></div>{window.remainingPercent!==null&&<progress max={100} value={window.remainingPercent} aria-label={`${bucket.name} ${quotaWindowLabel(window.windowDurationMins)}剩餘額度`}/>}<small>重設：{at(window.resetsAt)}</small></div>;})}</div>)}
          {runtime&&!displayed&&!quota?.error&&<p className="quota-unavailable" role="status">{busy?'正在讀取帳戶額度…':'尚未取得額度；未提供不代表剩餘為零。'}</p>}
          {runtime&&displayed?.ordinaryUsageAllowed===false&&<p className="quota-unavailable">Runtime 回報目前無法使用一般帳戶額度。</p>}
          {displayed&&<p className="quota-updated">快照時間：{new Date(displayed.updatedAt).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'})}</p>}
          <p className="quota-footnote">此為 Runtime 帳戶的共享額度，包含其他裝置的使用。</p>
        </>
      ):(
        <>
          {claudeRuntime?<><p className="quota-account">{claudeAccountLabel}</p><button className="text-button quota-refresh" onClick={onClaudeRefresh} disabled={busy}><Glyph name="refresh" size={14}/>{busy?'讀取中…':'更新剩餘用量'}</button></>:<div className="quota-unavailable"><p>連接 Claude Code 後，將在此讀取 5 小時額度 (5 hour limit) 與 7 天額度。</p><button className="secondary compact" onClick={()=>{close();onConnect('claude');}}>連接 Claude Code</button></div>}
          {claudeQuota?.error&&<p role="status" className="quota-unavailable">{claudeQuota.error}</p>}{claudeRuntime?.authMode==='official'&&claudeQuota?.error&&<button className="secondary compact" onClick={()=>{close();onConnect('claude');}}>檢查 Claude Runtime 與登入設定</button>}{claudeQuota?.stale&&claudeQuota.windows.length>0&&<p className="quota-stale">以下為先前快照，並非目前剩餘額度。</p>}{claudeRuntime&&displayClaudeWindows.map(w=><div className="quota-bucket" key={w.id}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline'}}>
              <h4>{w.name}</h4>
              <small style={{fontSize:'10px',color:'var(--muted)'}}>{quotaWindowLabel(w.windowDurationMins)}</small>
            </div>
            <div className="quota-window">
              <div>
                <span>剩餘額度</span>
                <strong>{w.remainingPercent===null?'未提供':`${Math.round(w.remainingPercent*10)/10}%`}<small>{w.remainingPercent===null?'':' 剩餘'}</small></strong>
              </div>
              {w.remainingPercent!==null?(
                <progress max={100} value={w.remainingPercent} aria-label={`${w.name} 剩餘額度`}/>
              ):(
                <small>尚無可用的額度比例</small>
              )}
              <small>{w.resetsAt?`重設時間：${at(w.resetsAt)}`:(w.pendingNotice||'重設時間：依 Claude CLI 原生事件更新')}</small>
            </div>
          </div>)}
          {claudeRuntime&&claudeQuota&&claudeQuota.updatedAt>0&&<p className="quota-updated">來源：{claudeQuota.source||'原生事件'} · 狀態：{claudeQuota.status} · 快照時間：{new Date(claudeQuota.updatedAt).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'})}</p>}
          <p className="quota-footnote">此為 Runtime 帳戶的共享額度，透過獨立查詢與原生事件更新。</p>
        </>
      )}

      <button className="quota-report-link" onClick={()=>{close();onReport();}}>查看用量與報告<Glyph name="arrow" size={14}/></button>
    </section>}
  </div>;
}
