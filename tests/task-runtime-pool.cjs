const {test}=require('node:test'),assert=require('node:assert/strict');
const {TaskRuntimePool}=require('../dist-main/task-runtime-pool');
test('concurrent tasks get distinct runtimes; stop and stale completion do not release another task',async()=>{
 let sequence=0;const closed=[];const pool=new TaskRuntimePool(id=>closed.push(id));pool.register({runtimeId:'root'},async()=>({runtimeId:'worker-'+(++sequence)}));
 const [a,b,c]=await Promise.all(['a','b','c'].map(id=>pool.acquire('root',id,id)));
 assert.equal(new Set([a.runtimeId,b.runtimeId,c.runtimeId]).size,3);
 await assert.rejects(pool.acquire('root','a','duplicate'),/對話已在執行/);
 pool.release(a.runtimeId,'wrong');await assert.rejects(pool.acquire('root','a','duplicate'),/對話已在執行/);
 pool.release(a.runtimeId,'a');const resumed=await pool.acquire('root','a','a-next');assert.equal(resumed.runtimeId,a.runtimeId);
 pool.release(a.runtimeId,'a');await assert.rejects(pool.acquire('root','a','duplicate'),/對話已在執行/);
 await assert.rejects(pool.acquire('root','b','duplicate'),/對話已在執行/);
 await pool.disconnect('root');assert.deepEqual(new Set(closed),new Set(['root','worker-1','worker-2']));
});
test('capacity counts in-flight startup and failure/disconnect release claims',async()=>{
 let resolve;const closed=[];const pool=new TaskRuntimePool(id=>closed.push(id),2);
 pool.register({runtimeId:'root'},()=>new Promise(r=>resolve=r));await pool.acquire('root','one','one');
 const pending=pool.acquire('root','two','two');await assert.rejects(pool.acquire('root','three','three'),/最多/);
 await pool.disconnect('root');resolve({runtimeId:'late'});await assert.rejects(pending,/已關閉/);assert.ok(closed.includes('late'));
 pool.register({runtimeId:'new'},async()=>{throw Error('startup failed')});await pool.acquire('new','three','retry');await assert.rejects(pool.acquire('new','two','retry'),/startup failed/);
 pool.release('new','retry');assert.equal((await pool.acquire('new','two','retry2')).runtimeId,'new');
});
test('same chat cannot run twice through separate window connections',async()=>{
 const pool=new TaskRuntimePool(()=>{});for(const id of ['window-a','window-b'])pool.register({runtimeId:id},async()=>({runtimeId:id+'-worker'}));
 await pool.acquire('window-a','shared-chat','request-a');await assert.rejects(pool.acquire('window-b','shared-chat','request-b'),/對話已在執行/);
 pool.release('window-a','request-a');await pool.acquire('window-b','shared-chat','request-b');
});
