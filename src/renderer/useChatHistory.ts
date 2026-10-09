import {useEffect,useRef,useState} from 'react';
interface Chat {id:string}
/** Coalesce streaming saves; await the final commit before the window closes. */
export function useChatHistory<T extends Chat>(chats:T[],setChats:(value:T[])=>void,legacy:()=>T[],normalize:(values:unknown[])=>T[],notify:(text:string)=>void,beforeFlush:()=>void,flushDrafts?:()=>Promise<unknown>){
 const [ready,setReady]=useState(false),latest=useRef(chats),saved=useRef(new Map<string,T>()),chain=useRef<Promise<unknown>>(Promise.resolve()),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);const loaded=useRef(false);latest.current=chats;
 const flush=useRef<()=>Promise<unknown>>(async()=>{});
 flush.current=()=>{
  if(!loaded.current)return Promise.resolve();
  if(timer.current)clearTimeout(timer.current);timer.current=undefined;
  const snapshot=latest.current;
  const operation=async()=>{const changes=snapshot.filter(chat=>saved.current.get(chat.id)!==chat);await window.agentBridge.history.save({ids:snapshot.map(chat=>chat.id),changes});saved.current=new Map(snapshot.map(chat=>[chat.id,chat]));};
  const result=chain.current.then(operation);chain.current=result.catch(()=>{});return result;
 };
 useEffect(()=>{
  let active=true;
  if(!window.agentBridge?.history){const values=legacy();latest.current=values;setChats(values);setReady(true);return;}
  const initialize=async()=>{
   const stored=await window.agentBridge.history.load();const values=stored===null?legacy():normalize(stored);
   if(stored===null){await window.agentBridge.history.save({ids:values.map(chat=>chat.id),changes:values});}
   if(!active)return;saved.current=new Map(values.map(chat=>[chat.id,chat]));latest.current=values;loaded.current=true;setChats(values);setReady(true);
   // Remove the old key only after a confirmed durable migration.
   if(stored===null)localStorage.removeItem('studio.chats');
  };
  void initialize().catch(()=>{if(active)notify('對話讀取失敗，原有內容已保留。請先匯出／備份後再處理儲存問題。');});
  const off=window.agentBridge.history.onFlush(id=>{beforeFlush();void Promise.all([flush.current(),flushDrafts?.()]).then(()=>window.agentBridge.history.flushed(id,true),()=>window.agentBridge.history.flushed(id,false));});
  return()=>{active=false;off();if(timer.current)clearTimeout(timer.current);};
 },[]);
 useEffect(()=>{
  if(!ready)return;
  if(timer.current)return;
  timer.current=setTimeout(()=>{void flush.current().catch(()=>notify('對話儲存失敗，請匯出對話以保留內容。'));},500);
 },[chats,ready,notify]);
 return ready;
}
