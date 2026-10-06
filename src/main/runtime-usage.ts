export interface TokenCount {totalTokens:number|null;inputTokens:number|null;cachedInputTokens:number|null;outputTokens:number|null}
const finite=(value:any)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
export function tokenCount(value:any):TokenCount{return{totalTokens:finite(value?.totalTokens),inputTokens:finite(value?.inputTokens),cachedInputTokens:finite(value?.cachedInputTokens),outputTokens:finite(value?.outputTokens)}}
export function tokenDelta(current:TokenCount,baseline?:TokenCount){return Object.fromEntries(Object.entries(current).map(([key,value])=>{const old=baseline?.[key as keyof TokenCount];return[key,value!==null&&old!==null&&old!==undefined&&value>=old?value-old:null]})) as unknown as TokenCount;}
export function rateLimitSummary(value:any,at=Date.now()){
 const window=(raw:any)=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;const used=finite(raw.usedPercent),duration=finite(raw.windowDurationMins),reset=finite(raw.resetsAt);if(used===null&&duration===null&&reset===null)return null;return{usedPercent:used===null?null:Math.min(100,used),remainingPercent:used===null?null:Math.max(0,100-Math.min(100,used)),windowDurationMins:duration,resetsAt:reset}};
 const map=value?.rateLimitsByLimitId;
 const entries=map&&typeof map==='object'&&!Array.isArray(map)&&Object.keys(map).length?Object.entries(map):value?.rateLimits&&typeof value.rateLimits==='object'?[[value.rateLimits.limitId||'codex',value.rateLimits]]:[];
 const buckets=entries.map(([id,raw]:any)=>({id:String(id).slice(0,100),name:typeof raw?.limitName==='string'?raw.limitName.slice(0,100):String(id).slice(0,100),primary:window(raw?.primary),secondary:window(raw?.secondary)}));
 return{updatedAt:at,available:buckets.some(bucket=>!!(bucket.primary||bucket.secondary)),ordinaryUsageAllowed:typeof value?.ordinaryUsageAllowed==='boolean'?value.ordinaryUsageAllowed:null,buckets};
}
export function sharedQuotaChange(first:ReturnType<typeof rateLimitSummary>,last:ReturnType<typeof rateLimitSummary>){return last.buckets.flatMap(bucket=>['primary','secondary'].map(kind=>{const current=bucket[kind as 'primary'|'secondary'];const prior=first.buckets.find(old=>old.id===bucket.id)?.[kind as 'primary'|'secondary'];const sameWindow=!!current&&!!prior&&current.resetsAt!==null&&current.resetsAt===prior.resetsAt;return{id:bucket.id,window:kind,usedPercentChange:sameWindow&&current!.usedPercent!==null&&prior!.usedPercent!==null&&current!.usedPercent>=prior!.usedPercent?current!.usedPercent-prior!.usedPercent:null,resetChanged:!!current&&!!prior&&current.resetsAt!==null&&prior.resetsAt!==null&&current.resetsAt!==prior.resetsAt}}));}
/** Rolling notifications omit other buckets and may lack nullable metadata. */
export function mergeRateLimitSummary(previous:ReturnType<typeof rateLimitSummary>|undefined,patch:any,at=Date.now()){
 const incoming=rateLimitSummary(patch,at),buckets=[...(previous?.buckets||[])];
 for(const bucket of incoming.buckets){
  const index=buckets.findIndex(old=>old.id===bucket.id),old=index>=0?buckets[index]:undefined;
  const raw=patch?.rateLimitsByLimitId?.[bucket.id]||patch?.rateLimits;
  const mergeWindow=(current:typeof bucket.primary,next:typeof bucket.primary)=>next?{usedPercent:next.usedPercent??current?.usedPercent??null,remainingPercent:next.remainingPercent??current?.remainingPercent??null,windowDurationMins:next.windowDurationMins??current?.windowDurationMins??null,resetsAt:next.resetsAt??current?.resetsAt??null}:current||null;
  const merged={...bucket,name:typeof raw?.limitName==='string'?bucket.name:old?.name||bucket.name,primary:mergeWindow(old?.primary||null,bucket.primary),secondary:mergeWindow(old?.secondary||null,bucket.secondary)};
  if(index>=0)buckets[index]=merged;else buckets.push(merged);
 }
 return{updatedAt:at,available:buckets.some(bucket=>!!(bucket.primary||bucket.secondary)),ordinaryUsageAllowed:incoming.ordinaryUsageAllowed??previous?.ordinaryUsageAllowed??null,buckets};
}

export interface UsageRecord {
 requestId:string;agent:'codex'|'claude';hostKey:string;authMode?:'official'|'api';model:string;
 startedAt:number;finishedAt?:number;status:'running'|'completed'|'error'|'cancelled'|'interrupted';
 usage?:TokenCount&{complete:boolean;source:string;costUsd?:number|null;cacheWriteTokens?:number|null};
}
export function updateUsage(records:UsageRecord[],requestId:string,raw:any):UsageRecord[]{
 const counts=tokenCount(raw);
 return records.map(record=>record.requestId===requestId?{...record,usage:{...counts,complete:raw?.complete===true&&counts.totalTokens!==null,source:typeof raw?.source==='string'?raw.source.slice(0,100):'unknown',costUsd:finite(raw?.costUsd),cacheWriteTokens:finite(raw?.cacheWriteTokens)}}:record);
}
export function usageTotals(records:UsageRecord[]){
 const complete=records.filter(record=>record.usage?.complete&&record.usage.totalTokens!==null);
 return{requests:records.length,completed:records.filter(record=>record.status==='completed').length,measured:complete.length,unmeasured:records.length-complete.length,totalTokens:complete.reduce((sum,record)=>sum+record.usage!.totalTokens!,0)};
}
export function claudeRateLimitSummary(raw:any,at=Date.now()){
 const type=typeof raw?.rateLimitType==='string'?raw.rateLimitType:'unknown';
 const windows=raw?.unifiedWindows&&typeof raw.unifiedWindows==='object'?Object.entries(raw.unifiedWindows):[[type,raw]];
 const durations:Record<string,number>={five_hour:300,seven_day:10080,seven_day_opus:10080,seven_day_sonnet:10080};
 return{updatedAt:at,status:typeof raw?.status==='string'?raw.status:'unknown',windows:windows.map(([id,value]:any)=>{const fraction=finite(value?.utilization);return{id:String(id).slice(0,100),remainingPercent:fraction!==null&&fraction<=1?Math.max(0,100-fraction*100):null,resetsAt:finite(value?.resetsAt),windowDurationMins:durations[id]??null};})};
}
