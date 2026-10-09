import { useMemo, useState } from 'react';
import { Glyph } from './StudioUI';
import { sharedQuotaChange, usageTotals, type ClaudeQuotaSummary, type UsageRecord, type rateLimitSummary } from '../main/runtime-usage';
type Quota=ReturnType<typeof rateLimitSummary>&{error?:string;lastKnown?:ReturnType<typeof rateLimitSummary>};
const number=(value:number|null|undefined)=>value==null?'未提供':value.toLocaleString('zh-TW');
const time=(at:number|null|undefined,seconds=false)=>at?new Date(seconds?at*1000:at).toLocaleString('zh-TW'):'未提供';
const duration=(mins:number|null)=>mins==null?'額度視窗':mins>=1440?`${Math.round(mins/1440*10)/10} 天額度`:`${Math.round(mins/60*10)/10} 小時額度`;
export function UsagePage({claudeQuota,claudeConnected,claudeAuthMode,quota,baseline,records,hostKey,hostName,busy,onRefresh,onConnect}:{claudeQuota?:ClaudeQuotaSummary;claudeConnected:boolean;claudeAuthMode?:string;quota?:Quota;baseline?:Quota;records:UsageRecord[];hostKey?:string;hostName?:string;busy:boolean;onRefresh:()=>void;onConnect:()=>void}){
 const [period,setPeriod]=useState('today');const [filter,setFilter]=useState('codex');
 const [from,setFrom]=useState('');const [to,setTo]=useState('');const [feedback,setFeedback]=useState('');
 const start=period==='all'?0:period==='custom'?(from?new Date(from).getTime():0):period==='week'?Date.now()-7*86400000:new Date().setHours(0,0,0,0);
 const end=period==='custom'&&to?new Date(to).getTime():Infinity;
 const selected=useMemo(()=>records.filter(record=>record.startedAt>=start&&record.startedAt<=end&&(filter==='all'||record.agent===filter)&&(filter!=='codex'||!hostKey||record.hostKey===hostKey)),[records,start,end,filter,hostKey]);
 const totals=usageTotals(selected);const displayed=quota?.available?quota:quota?.lastKnown;
 const changes=baseline&&displayed?sharedQuotaChange(baseline,displayed):[];
 const report=()=>[
 'AgentBridge 使用報告',`產生時間：${time(Date.now())}`,`範圍：${filter==='codex'?'Codex'+(hostName?` · ${hostName}`:'（本機記錄）'):filter==='claude'?'Claude Code':'所有 Agent'}`,
 `開始：${start?time(start):'最早保留紀錄'}；結束：${end===Infinity?'現在':time(end)}`,
 `App 發起回合：${totals.requests}；成功完成：${totals.completed}`,
 `已取得完整計數：${totals.measured}；缺少完整計數：${totals.unmeasured}`,
 `完整回合合計 Tokens：${totals.measured?number(totals.totalTokens):'未提供'}`,
 `額度快照：${displayed?time(displayed.updatedAt):'未取得'}`,
 ...(displayed?.buckets||[]).flatMap(bucket=>[bucket.primary,bucket.secondary].filter(Boolean).map(window=>`${bucket.name} · ${duration(window!.windowDurationMins)}：剩餘 ${window!.remainingPercent==null?'未提供':`${window!.remainingPercent}%`}；重設 ${time(window!.resetsAt,true)}`)),
 ...(claudeQuota?.windows||[]).map(window=>`Claude ${window.name}：剩餘 ${window.remainingPercent==null?'未提供':`${window.remainingPercent}%`}；重設 ${time(window.resetsAt,true)}`),
 '額度屬於朋友的共享帳號，可能包含他和其他裝置的使用；剩餘比例不能換算為我個人的精確扣額或可用 Token 數。',
 'App Tokens 僅合計完整回合計數，缺資料不視為零；已取消或失敗的回合也可能消耗額度。',
 '本機紀錄最多保留 5,000 個回合，刪除本機資料會移除紀錄。'
 ].join('\n');
 const exportFile=(format:'txt'|'json')=>{const payload=format==='txt'?report():JSON.stringify({version:1,exportedAt:new Date().toISOString(),period:{start,end:end===Infinity?null:end},totals,quota:displayed||null,claudeQuota:claudeQuota||null,sharedQuotaChange:changes,records:selected,notes:'共享帳號額度變化不等於 App 個人使用量。'},null,2);const url=URL.createObjectURL(new Blob([payload],{type:format==='txt'?'text/plain;charset=utf-8':'application/json'}));const link=document.createElement('a');link.href=url;link.download=`AgentBridge-使用報告-${new Date().toISOString().slice(0,10)}.${format}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setFeedback('報告已匯出');};
 return <section className="page-shell usage-page"><div className="page-heading"><div><span className="page-eyebrow">用量透明，方便匯報</span><h1>用量與報告</h1><p>朋友的帳號額度，以及這個 App 實際記錄的使用量。</p></div><button className="secondary" disabled={busy||(!hostKey&&!claudeConnected)} onClick={onRefresh}><Glyph name="refresh" size={17}/>{busy?'讀取中…':'更新額度'}</button></div>
 <div className="usage-quota-heading"><h2>朋友的 Codex 帳號</h2><span>{hostName||'尚未連線'}</span></div>
 {!hostKey&&<div className="usage-empty"><p>連接朋友的 Codex Runtime 後，會從他的帳號讀取額度。</p><button className="secondary" onClick={onConnect}>設定 Codex 連線</button></div>}
 {quota?.error&&<p role="status" className="page-note">{quota.error}{displayed&&' 以下為先前快照，並非目前額度。'}</p>}
 <div className="usage-quota-grid">{displayed?.buckets.flatMap(bucket=>(['primary','secondary'] as const).map(kind=>{const window=bucket[kind];if(!window)return null;const change=changes.find(value=>value.id===bucket.id&&value.window===kind);return <article className="usage-quota-card" key={bucket.id+kind}><div><b>{bucket.name}</b><span>{duration(window.windowDurationMins)}</span></div><strong>{window.remainingPercent==null?'未提供':`${Math.round(window.remainingPercent*10)/10}%`}<small>剩餘</small></strong><progress aria-label={`${bucket.name} ${duration(window.windowDurationMins)}剩餘額度`} max={100} value={window.remainingPercent??undefined}/><p>重設：{time(window.resetsAt,true)}</p>{change&&<small>{change.usedPercentChange==null?'額度資料不足或視窗不同，無法比較':`本次連線期間共享使用比例增加 ${Math.round(change.usedPercentChange*100)/100} 個百分點`}</small>}</article>}))}</div>
 {hostKey&&!displayed&&!busy&&<p className="page-note">尚未取得額度資料；未提供不代表剩餘為零。</p>}
 {displayed&&<p className="page-note">更新時間：{time(displayed.updatedAt)}。此為共享帳號額度，可能包含朋友和其他裝置的使用；系統未提供「你個人扣掉多少百分比」。</p>}
 <div className="usage-quota-heading"><h2>朋友的 Claude Code</h2><span>{claudeConnected?(claudeAuthMode==='official'?'官方帳號':'API 模式'):'尚未連線'}</span></div>
 {claudeQuota?.error&&<p role="status" className="settings-error">{claudeQuota.error}{claudeQuota.stale?'（先前快照）':''}</p>}<div className="usage-quota-grid">{claudeQuota?.windows.map(window=><article className="usage-quota-card" key={window.id}><div><b>{window.name}</b><span>{duration(window.windowDurationMins)}</span></div><strong>{window.remainingPercent==null?'未提供':`${Math.round(window.remainingPercent*10)/10}%`}<small>剩餘</small></strong>{window.remainingPercent!=null&&<progress aria-label={`${window.name}剩餘額度`} max={100} value={window.remainingPercent}/>}<p>重設：{time(window.resetsAt,true)}</p><small>原生狀態：{claudeQuota.status}</small></article>)}</div>
 <p className="page-note">{claudeQuota?`原生事件更新：${time(claudeQuota.updatedAt)}。`:'Claude 尚未回報額度事件。'}僅顯示朋友的 CLI 實際回報資料；沒有剩餘比例時保留「未提供」。API 帳單與餘額須以供應商資料為準。</p>
 <div className="usage-report-heading"><h2>App 使用紀錄</h2><div><select aria-label="使用紀錄 Agent" value={filter} onChange={e=>setFilter(e.target.value)}><option value="codex">Codex（目前主機）</option><option value="claude">Claude Code</option><option value="all">所有 Agent</option></select><select aria-label="報告期間" value={period} onChange={e=>setPeriod(e.target.value)}><option value="today">今天</option><option value="week">最近 7 天</option><option value="all">所有保留紀錄</option><option value="custom">自訂期間</option></select></div></div>
 {period==='custom'&&<div className="usage-date-fields"><label>開始<input type="datetime-local" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>結束<input type="datetime-local" value={to} onChange={e=>setTo(e.target.value)}/></label></div>}
 <div className="usage-totals"><div><b>{number(totals.requests)}</b><span>發起回合</span></div><div><b>{number(totals.completed)}</b><span>成功完成</span></div><div><b>{totals.measured?number(totals.totalTokens):'未提供'}</b><span>完整回合 Tokens 合計</span></div><div><b>{number(totals.unmeasured)}</b><span>缺少完整計數</span></div></div>
 <div className="usage-report-actions"><button className="secondary" onClick={()=>void navigator.clipboard.writeText(report()).then(()=>setFeedback('報告已複製')).catch(()=>setFeedback('無法複製，請匯出文字報告'))}><Glyph name="copy" size={16}/>複製匯報</button><button className="secondary" onClick={()=>exportFile('txt')}><Glyph name="export" size={16}/>匯出文字</button><button className="text-button" onClick={()=>exportFile('json')}>匯出詳細 JSON</button><span role="status">{feedback}</span></div>
 <p className="page-note">記錄包含模型、時間、結果與原生程序回報的 Tokens；重複更新會覆蓋同一回合，避免重複加總。缺少完整計數、失敗或取消的回合，仍可能消耗額度。Claude API 原生回報的估計費用不是供應商帳單。</p>
 <div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>時間／Agent</th><th>模型</th><th>結果</th><th>Tokens</th></tr></thead><tbody>{selected.slice().reverse().slice(0,100).map(record=><tr key={record.requestId}><td>{time(record.startedAt)}<small>{record.agent==='codex'?'Codex':record.authMode==='official'?'Claude 官方帳號':'Claude API'}</small></td><td>{record.model||'原生預設'}</td><td>{{running:'處理中',completed:'完成',error:'失敗',cancelled:'取消',interrupted:'中斷'}[record.status]}</td><td>{record.usage?.complete?number(record.usage.totalTokens):'計數不完整'}{record.usage?.costUsd!=null&&<small>原生估計 ${record.usage.costUsd.toFixed(4)}</small>}</td></tr>)}</tbody></table>{!selected.length&&<p className="compact-empty">這個期間尚無使用紀錄。</p>}{selected.length>100&&<p className="page-note">顯示最近 100 個回合；匯出包含篩選後的全部紀錄。</p>}</div>
 </section>;
}
