const {test}=require('node:test');const assert=require('node:assert/strict');
const {rateLimitSummary,mergeRateLimitSummary,sharedQuotaChange,tokenCount,tokenDelta,updateUsage,usageTotals}=require('../dist-main/runtime-usage');
test('quota uses all limit buckets, clamps percentages and never exposes account identity or makes missing data zero',()=>{
 const quota=rateLimitSummary({accountId:'private',accessToken:'private',rateLimits:{primary:{usedPercent:999}},rateLimitsByLimitId:{codex:{limitName:'Codex',primary:{usedPercent:21.2,windowDurationMins:300,resetsAt:2000},secondary:{usedPercent:101}},other:{primary:{}}}},123);
 assert.equal(quota.updatedAt,123);assert.equal(quota.buckets.length,2);assert.equal(quota.buckets[0].primary.remainingPercent,78.8);assert.equal(quota.buckets[0].secondary.remainingPercent,0);assert.equal(quota.buckets[1].primary,null);assert.ok(!JSON.stringify(quota).includes('private'));assert.equal(rateLimitSummary(null).available,false);
});
test('unknown windows remain unavailable, while metadata-only windows never invent percentages',()=>{
 for(const raw of [null,{rateLimits:{primary:{}}},{rateLimits:{primary:'invalid'}},{rateLimits:{primary:[]}},{}])assert.equal(rateLimitSummary(raw).available,false);
 const value=rateLimitSummary({rateLimits:{primary:{resetsAt:0,windowDurationMins:300}}});assert.equal(value.available,true);assert.equal(value.buckets[0].primary.remainingPercent,null);assert.equal(value.buckets[0].primary.resetsAt,0);
});
test('sparse notifications preserve other buckets, both windows and nullable metadata without exposing raw account fields',()=>{
 const first=rateLimitSummary({ordinaryUsageAllowed:false,rateLimitsByLimitId:{codex:{limitName:'Codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:2000},secondary:{usedPercent:30,windowDurationMins:10080,resetsAt:3000}},extra:{primary:{usedPercent:50,resetsAt:4000}}}},1);
 const updated=mergeRateLimitSummary(first,{accountId:'private',rateLimits:{limitId:'codex',limitName:null,primary:{usedPercent:22,windowDurationMins:null,resetsAt:null},secondary:null}},2);
 assert.equal(updated.buckets.length,2);assert.equal(updated.buckets[0].primary.remainingPercent,78);assert.equal(updated.buckets[0].primary.resetsAt,2000);assert.equal(updated.buckets[0].primary.windowDurationMins,300);assert.equal(updated.buckets[0].secondary.remainingPercent,70);assert.equal(updated.buckets[1].primary.remainingPercent,50);assert.equal(updated.ordinaryUsageAllowed,false);assert.equal(updated.buckets[0].name,'Codex');assert.ok(!JSON.stringify(updated).includes('private'));
});
test('quota comparison never attributes a reset or decreasing account counter to the app',()=>{
 const q=(used,reset)=>rateLimitSummary({rateLimits:{primary:{usedPercent:used,resetsAt:reset}}});assert.equal(sharedQuotaChange(q(12,2000),q(14,2000))[0].usedPercentChange,2);assert.equal(sharedQuotaChange(q(12,2000),q(1,3000))[0].usedPercentChange,null);assert.equal(sharedQuotaChange(q(12,2000),q(1,2000))[0].usedPercentChange,null);assert.equal(sharedQuotaChange(q(12,null),q(14,null))[0].usedPercentChange,null);
});
test('turn token updates replace duplicate notifications, preserve unknown counts and exclude incomplete records from total',()=>{
 const records=[{requestId:'a',agent:'codex',hostKey:'fixture',model:'model',startedAt:1,status:'completed'},{requestId:'b',agent:'codex',hostKey:'fixture',model:'model',startedAt:2,status:'cancelled'}];
 const delta=tokenDelta(tokenCount({totalTokens:140,inputTokens:100,cachedInputTokens:20,outputTokens:40}),tokenCount({totalTokens:100,inputTokens:70,cachedInputTokens:10,outputTokens:30}));assert.equal(delta.totalTokens,40);
 let updated=updateUsage(records,'a',{...delta,complete:true,source:'codex-thread-delta'});updated=updateUsage(updated,'a',{...delta,complete:true});updated=updateUsage(updated,'b',{totalTokens:null,inputTokens:100,outputTokens:10,complete:false});
 assert.deepEqual(usageTotals(updated),{requests:2,completed:1,measured:1,unmeasured:1,totalTokens:40});assert.equal(tokenDelta(tokenCount({totalTokens:12})).totalTokens,null);assert.equal(tokenDelta(tokenCount({totalTokens:12}),tokenCount({totalTokens:100})).totalTokens,null);assert.equal(updateUsage(records,'unknown',{totalTokens:999,complete:true}).length,2);
});
