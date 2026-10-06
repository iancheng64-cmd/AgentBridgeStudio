import {useCallback,useEffect,useRef,useState} from 'react';
import {RuntimeQuotaState,type AccountQuota} from '../main/quota-state';
export function useCodexQuota(runtimeId:string|undefined,authenticated:boolean,readQuota:(id:string)=>Promise<AccountQuota>){
  const state=useRef(new RuntimeQuotaState());
  const readRef=useRef(readQuota);readRef.current=readQuota;
  const [,render]=useState(0);
  // Clear synchronously during selection, before any frame can show another host's data.
  state.current.select(runtimeId);
  const refresh=useCallback(async()=>{
    const request=state.current.begin();if(!request)return;
    render(value=>value+1);
    let quota:AccountQuota;
    try{quota=await readRef.current(request.runtimeId);}
    catch{quota={updatedAt:Date.now(),available:false,ordinaryUsageAllowed:null,buckets:[],error:'暫時無法讀取此 Runtime 帳戶的剩餘用量。'};}
    if(state.current.complete(request,quota))render(value=>value+1);
  },[]);
  const receive=useCallback((id:string,quota:AccountQuota)=>{if(state.current.receive(id,quota)){render(value=>value+1);if(quota.resetBaseline)void refresh();}},[refresh]);
  useEffect(()=>{
    if(!runtimeId)return;
    void refresh();const timer=setInterval(()=>void refresh(),60000);return()=>clearInterval(timer);
  },[runtimeId,authenticated,refresh]);
  return{...state.current.view,refresh,receive};
}
