/** A task owns one native process, including its model, tools and cancellation. */
export class TaskRuntimePool<T extends {runtimeId:string}> {
  private roots = new Map<string, {open:()=>Promise<T>; entries:Map<string,Entry<T>>; pending:Set<string>; closed:boolean}>();
  private tasks = new Map<string,string>();
  constructor(private close:(id:string)=>Promise<void>|void, private limit=8) {}

  register(snapshot:T, open:()=>Promise<T>) {
    this.roots.set(snapshot.runtimeId,{open,entries:new Map([[snapshot.runtimeId,{snapshot,used:Date.now()}]]),pending:new Set(),closed:false});
  }
  async acquire(rootId:string,taskId:string,requestId:string):Promise<T> {
    if(!taskId||!requestId||taskId.length>200||requestId.length>200)throw new Error('任務識別碼無效。');
    const root=this.roots.get(rootId);
    if(!root||root.closed)throw new Error('任務連線已中斷，請重新連線。');
    // Claim synchronously, before any process startup or other await.
    if(this.tasks.has(taskId))throw new Error('這個對話已在執行，請先停止該對話的工作。');
    this.tasks.set(taskId,requestId);root.pending.add(requestId);
    let entry=[...root.entries.values()].find(value=>value.taskId===taskId&&!value.requestId);
    try {
      if(!entry)entry=[...root.entries.values()].filter(value=>!value.requestId).sort((a,b)=>a.used-b.used)[0];
      if(entry){entry.requestId=requestId;entry.taskId=taskId;}
      else {
        if(root.entries.size+root.pending.size>this.limit)throw new Error(`目前最多可同時執行 ${this.limit} 個任務，請等其中一個完成。`);
        const snapshot=await root.open();
        if(root.closed){await this.close(snapshot.runtimeId);throw new Error('建立任務時連線已關閉。');}
        entry={snapshot,taskId,requestId,used:Date.now()};root.entries.set(snapshot.runtimeId,entry);
      }
      entry.used=Date.now();return entry.snapshot;
    } catch(error) {
      if(this.tasks.get(taskId)===requestId)this.tasks.delete(taskId);
      throw error;
    } finally {root.pending.delete(requestId);}
  }
  release(id:string,requestId:string) {
    for(const root of this.roots.values()){
      const entry=root.entries.get(id);if(!entry||entry.requestId!==requestId)continue;
      if(entry.taskId&&this.tasks.get(entry.taskId)===requestId)this.tasks.delete(entry.taskId);
      entry.requestId=undefined;entry.used=Date.now();return;
    }
  }
  forget(id:string) {
    for(const root of this.roots.values()){
      const entry=root.entries.get(id);if(!entry)continue;
      if(entry.requestId)this.release(id,entry.requestId);
      root.entries.delete(id);
    }
  }
  async disconnect(rootId:string) {
    const root=this.roots.get(rootId);if(!root)return;
    root.closed=true;this.roots.delete(rootId);
    for(const entry of root.entries.values())if(entry.taskId&&this.tasks.get(entry.taskId)===entry.requestId)this.tasks.delete(entry.taskId);
    await Promise.allSettled([...root.entries.keys()].map(id=>this.close(id)));
  }
}
interface Entry<T> {snapshot:T;taskId?:string;requestId?:string;used:number}
