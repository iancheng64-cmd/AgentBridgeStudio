import {useEffect,useRef,useState} from 'react';
interface Chat {id:string; temporary?:boolean; _revision?:number}
/** Save task deltas and explicit removals; stale windows never replace the index. */
export function useChatHistory<T extends Chat>(chats:T[],setChats:(value:T[])=>void,legacy:()=>T[],normalize:(values:unknown[])=>T[],notify:(text:string)=>void,beforeFlush:()=>void,flushDrafts?:()=>Promise<unknown>){
 const [ready,setReady]=useState(false),latest=useRef(chats),saved=useRef(new Map<string,T>()),revisions=useRef<Record<string,number>>({}),chain=useRef<Promise<unknown>>(Promise.resolve()),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const loaded=useRef(false);latest.current=chats;
 const flush=useRef<()=>Promise<unknown>>(async()=>{});
 flush.current=()=>{
  if(!loaded.current)return Promise.resolve();
  if(timer.current)clearTimeout(timer.current);timer.current=undefined;
  const snapshot=latest.current.filter(chat=>!chat.temporary),knownAtFlush=[...saved.current.keys()];
  const operation=async()=>{
   const changes=snapshot.filter(chat=>saved.current.get(chat.id)!==chat),ids=snapshot.map(chat=>chat.id);
   const removedIds=knownAtFlush.filter(id=>!ids.includes(id));
   if(!changes.length&&!removedIds.length)return;
   const result=await window.agentBridge.history.save({ids,changes,removedIds,expectedRevisions:{...revisions.current}});
   for(const chat of result?.changes||[])revisions.current[chat.id]=chat._revision||0;
   for(const chat of changes)saved.current.set(chat.id,chat);for(const id of removedIds){saved.current.delete(id);delete revisions.current[id];}
  };
  const result=chain.current.then(operation);chain.current=result.catch(()=>{});return result;
 };
 useEffect(()=>{
  let active=true;
  if(!window.agentBridge?.history){const values=legacy();latest.current=values;setChats(values);setReady(true);return;}
  const initialize=async()=>{
   const stored=await window.agentBridge.history.load();const values=stored===null?legacy():normalize(stored);
   if(stored===null){const result=await window.agentBridge.history.save({ids:values.map(chat=>chat.id),changes:values,removedIds:[]});for(const chat of result?.changes||[])revisions.current[chat.id]=chat._revision||0;}
   if(!active)return;
   for(const chat of values)revisions.current[chat.id]=revisions.current[chat.id]||chat._revision||0;
   saved.current=new Map(values.map(chat=>[chat.id,chat]));latest.current=values;loaded.current=true;setChats(values);setReady(true);
   if(stored===null)localStorage.removeItem('studio.chats');
  };
  void initialize().catch(()=>{if(active)notify('對話讀取失敗，原有內容已保留。請先匯出／備份後再處理儲存問題。');});
  const changed=window.agentBridge.history.onChanged?.((event:{changes:T[];removedIds:string[]})=>{
   if(!loaded.current)return;
   // Apply only clean conversations. An optimistic revision check protects dirty ones.
   let next=[...latest.current];
   for(const incoming of event.changes||[]){
    const current=next.find(chat=>chat.id===incoming.id);
    if(current&&saved.current.get(incoming.id)!==current)continue;
    next=next.filter(chat=>chat.id!==incoming.id);next.push(incoming);
    saved.current.set(incoming.id,incoming);revisions.current[incoming.id]=incoming._revision||0;
   }
   for(const id of event.removedIds||[]){const current=next.find(chat=>chat.id===id);if(current&&saved.current.get(id)!==current)continue;next=next.filter(chat=>chat.id!==id);saved.current.delete(id);delete revisions.current[id];}
   latest.current=next;setChats(next);
  });
  const off=window.agentBridge.history.onFlush(id=>{beforeFlush();void Promise.all([flush.current(),flushDrafts?.()]).then(()=>window.agentBridge.history.flushed(id,true),()=>window.agentBridge.history.flushed(id,false));});
  return()=>{active=false;off();changed?.();if(timer.current)clearTimeout(timer.current);};
 },[]);
 useEffect(()=>{if(!ready||timer.current)return;timer.current=setTimeout(()=>{void flush.current().catch(()=>notify('對話儲存失敗或另一視窗已更新；目前文字仍保留，請先匯出。'));},500);},[chats,ready,notify]);
 return ready;
}
