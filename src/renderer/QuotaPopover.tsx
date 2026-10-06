import {useEffect,useRef,useState} from 'react';
import {Glyph} from './StudioUI';
import type {AccountQuota} from '../main/quota-state';
import type {RuntimeConnection} from './RuntimeControls';
export const quotaWindowLabel=(minutes:number|null)=>minutes===null?'額度視窗':minutes>=1440?`${Math.round(minutes/1440*10)/10} 天額度`:`${Math.round(minutes/60*10)/10} 小時額度`;
const at=(seconds:number|null)=>seconds===null?'未提供':new Date(seconds*1000).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
export function QuotaPopover({runtime,quota,busy,onRefresh,onReport,onConnect}:{runtime?:RuntimeConnection;quota?:AccountQuota;busy:boolean;onRefresh:()=>void;onReport:()=>void;onConnect:()=>void}){
  const [open,setOpen]=useState(false);
  const anchor=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement>(null);
  const close=()=>{setOpen(false);trigger.current?.focus();};
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
  const accountLabel=account?.type==='chatgpt'?`ChatGPT${account.planType?' · '+account.planType.toUpperCase():''}`:account?.type==='apiKey'?'API Key 帳戶':account?.type==='amazonBedrock'?'Amazon Bedrock':account?.authenticated?'Runtime 帳戶':'尚未登入';
  return <div className="quota-anchor" ref={anchor}>
    <button ref={trigger} className={`quota-trigger ${open?'active':''}`} aria-label="查看 Codex 帳戶剩餘用量" aria-expanded={open} aria-controls="codex-quota-popover" aria-haspopup="dialog" onClick={()=>{setOpen(!open);if(!open&&runtime)onRefresh();}}><Glyph name="history" size={16}/><span>Codex 剩餘用量</span><Glyph name="down" size={13}/></button>
    {open&&<section ref={panel} tabIndex={-1} id="codex-quota-popover" role="dialog" aria-label="Codex 帳戶剩餘用量" className="quota-popover">
      <div className="quota-popover-heading"><div><b>帳戶剩餘用量</b><small>Codex · {runtime?.hostName||'尚未連接 Runtime'}</small></div><button className="icon-btn tiny" aria-label="關閉剩餘用量" onClick={close}><Glyph name="close" size={16}/></button></div>
      {runtime?<><p className="quota-account">{accountLabel}</p><button className="text-button quota-refresh" onClick={onRefresh} disabled={busy}><Glyph name="refresh" size={14}/>{busy?'讀取中…':'更新剩餘用量'}</button></>:<div className="quota-unavailable"><p>連接 Codex Runtime 後，從該 Runtime 的登入帳戶讀取剩餘用量。</p><button className="secondary compact" onClick={()=>{close();onConnect();}}>連接 Codex Runtime</button></div>}
      {runtime&&quota?.error&&<p className="quota-unavailable" role="status">{quota.error}</p>}
      {stale&&<p className="quota-stale">以下為先前快照，並非目前剩餘用量。</p>}
      {runtime&&displayed?.buckets.filter(bucket=>bucket.primary||bucket.secondary).map(bucket=><div className={`quota-bucket ${stale?'stale':''}`} key={bucket.id}><h4>{bucket.name}</h4>{(['primary','secondary'] as const).map(kind=>{const window=bucket[kind];if(!window)return null;return <div className="quota-window" key={kind}><div><span>{quotaWindowLabel(window.windowDurationMins)}</span><strong>{window.remainingPercent===null?'未提供':`${Math.round(window.remainingPercent*10)/10}%`}<small>{window.remainingPercent===null?'':' 剩餘'}</small></strong></div>{window.remainingPercent!==null&&<progress max={100} value={window.remainingPercent} aria-label={`${bucket.name} ${quotaWindowLabel(window.windowDurationMins)}剩餘額度`}/>}<small>重設：{at(window.resetsAt)}</small></div>;})}</div>)}
      {runtime&&!displayed&&!quota?.error&&<p className="quota-unavailable" role="status">{busy?'正在讀取帳戶額度…':'尚未取得額度；未提供不代表剩餘為零。'}</p>}
      {runtime&&displayed?.ordinaryUsageAllowed===false&&<p className="quota-unavailable">Runtime 回報目前無法使用一般帳戶額度。</p>}
      {displayed&&<p className="quota-updated">快照時間：{new Date(displayed.updatedAt).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'})}</p>}
      <p className="quota-footnote">此為 Runtime 帳戶的共享額度，包含其他裝置的使用。</p><button className="quota-report-link" onClick={()=>{close();onReport();}}>查看用量與報告<Glyph name="arrow" size={14}/></button>
    </section>}
  </div>;
}
