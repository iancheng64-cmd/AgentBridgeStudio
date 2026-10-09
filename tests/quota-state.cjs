const {test}=require('node:test');const assert=require('node:assert/strict');
const {RuntimeQuotaState}=require('../dist-main/quota-state');const {rateLimitSummary}=require('../dist-main/runtime-usage');
const quota=(used)=>rateLimitSummary({rateLimits:{primary:{usedPercent:used}}});
test('device switches clear snapshots synchronously and reject an old device reply even after switching back',()=>{
 const state=new RuntimeQuotaState();state.select('A');const pending=state.begin();state.receive('A',quota(20));assert.equal(state.view.quota.buckets[0].primary.remainingPercent,80);
 state.select('B');assert.equal(state.view.quota,undefined);assert.equal(state.view.baseline,undefined);assert.equal(state.view.busy,false);assert.equal(state.receive('A',quota(90)),false);state.select('A');assert.equal(state.complete(pending,quota(90)),false);
});
test('notifications and account changes supersede pending reads; duplicate refresh and stale completions cannot stop a newer refresh',()=>{
 const state=new RuntimeQuotaState();state.select('A');const old=state.begin();assert.equal(state.begin(),undefined);
 state.receive('A',quota(30));assert.equal(state.complete(old,quota(10)),false);assert.equal(state.view.quota.buckets[0].primary.remainingPercent,70);
 const beforeLogout=state.begin();state.receive('A',{...rateLimitSummary(null),resetBaseline:true,error:'changed'});assert.equal(state.view.baseline,undefined);const fresh=state.begin();assert.equal(state.complete(beforeLogout,quota(10)),false);assert.equal(state.view.busy,true);assert.equal(state.complete(fresh,quota(50)),true);assert.equal(state.view.baseline.buckets[0].primary.remainingPercent,50);
 state.select();assert.equal(state.view.quota,undefined);assert.equal(state.begin(),undefined);
});
