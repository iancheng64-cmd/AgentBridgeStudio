import {useEffect,useRef,useState} from 'react';
interface Draft<T>{_revision?:number;id:string;title:string;messages:unknown[];text:string;attachments:T[]}
/** Separate atomic files keep unfinished prompts out of localStorage and model context. */
export function useComposerDrafts<T>(key:string,validAttachment:(value:unknown)=>boolean,notify:(text:string)=>void){
 const[values,setValues]=useState<Record<string,Draft<T>>>({}),[ready,setReady]=useState(false);
 const latest=useRef(values);latest.current=values;const loaded=useRef(false),chain=useRef<Promise<unknown>>(Promise.resolve()),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const dirty=useRef(new Set<string>()),saved=useRef(new Map<string,Draft<T>>()),revisions=useRef<Record<string,number>>({});
 const flush=useRef<()=>Promise<unknown>>(async()=>{});
 flush.current=()=>{
  if(!loaded.current)return Promise.resolve();if(timer.current)clearTimeout(timer.current);timer.current=undefined;
  const snapshot=Object.values(latest.current).filter(value=>value.text||value.attachments.length);
  const save=async()=>{const ids=snapshot.map(value=>value.id),changes=snapshot.filter(value=>saved.current.get(value.id)!==value),removedIds=[...saved.current.keys()].filter(id=>!ids.includes(id));if(!changes.length&&!removedIds.length)return;const result=await window.agentBridge.history.saveDrafts!({ids,changes,removedIds,expectedRevisions:{...revisions.current}});for(const value of result?.changes||[])revisions.current[value.id]=value._revision||0;saved.current=new Map(snapshot.map(value=>[value.id,value]));};
  const result=chain.current.then(save);chain.current=result.catch(()=>{});return result;
 };
 useEffect(()=>{let active=true;
  if(!window.agentBridge?.history?.loadDrafts){setReady(true);return;}
  void window.agentBridge.history.loadDrafts().then(stored=>{if(!active)return;const drafts:Record<string,Draft<T>>={};for(const value of stored||[]){const v=value as Draft<T>;if(v&&typeof v.id==='string'&&typeof v.text==='string'&&Array.isArray(v.attachments))drafts[v.id]={...v,attachments:v.attachments.filter(validAttachment)};}
   for(const value of Object.values(drafts))revisions.current[value.id]=value._revision||0;
   saved.current=new Map(Object.values(drafts).map(value=>[value.id,value]));loaded.current=true;setValues(previous=>{for(const id of dirty.current){if(previous[id])drafts[id]=previous[id];else delete drafts[id];}latest.current=drafts;return drafts;});setReady(true);
  }).catch(()=>{if(active)notify('草稿讀取失敗，原始檔案已保留。請先備份後再處理。');});
  return()=>{active=false;if(timer.current)clearTimeout(timer.current);};
 },[]);
 useEffect(()=>{if(!loaded.current||timer.current)return;timer.current=setTimeout(()=>{void flush.current().catch(()=>notify('草稿儲存失敗，請複製輸入內容以保留工作。'));},500);},[values,ready,notify]);
 const update=(patch:Partial<Pick<Draft<T>,'text'|'attachments'>>)=>{dirty.current.add(key);setValues(previous=>{const next={...previous,[key]:{...(previous[key]||{id:key,title:'Composer draft',messages:[],text:'',attachments:[]}),...patch}};latest.current=next;return next;});};
 const draft=values[key];
 return{ready,text:draft?.text||'',attachments:draft?.attachments||[],setText:(text:string)=>update({text}),setAttachments:(value:T[]|((previous:T[])=>T[]))=>update({attachments:typeof value==='function'?value(latest.current[key]?.attachments||[]):value}),clear:()=>{dirty.current.add(key);setValues(previous=>{const next={...previous};delete next[key];latest.current=next;return next;});},flush:()=>flush.current()};
}
