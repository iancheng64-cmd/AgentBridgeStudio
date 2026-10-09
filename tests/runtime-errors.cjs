const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtimeFailure,continuationContext}=require('../dist-main/runtime-errors');
test('native failure classes separate quota, throttling, login, context, model and service; unknown never invents exhaustion',()=>{
 for(const [code,category] of [['UsageLimitExceeded','quota'],['RateLimit','rate-limit'],['Unauthorized','auth'],['ContextWindowExceeded','context'],['ModelNotFound','model'],['InternalServerError','service']])assert.equal(runtimeFailure({codexErrorInfo:code}).category,category);
 assert.equal(runtimeFailure('HTTP 404 download not found').category,'unknown');assert.equal(runtimeFailure('no rollout found for thread id fixture').category,'session-missing');assert.ok(!/已達|已用完/.test(runtimeFailure({}).text));
});
test('continuation preserves bounded recent text, excludes failed answers and all executable tool/attachment records',()=>{
 const messages=[{role:'user',text:'old task',attachments:[{token:'must-not-replay'}]},{role:'assistant',text:'completed text',tools:[{command:'must-not-execute'}]},{role:'assistant',text:'quota failure',status:'error'},{role:'user',text:'x'.repeat(50000)}];
 const context=continuationContext(messages);assert.ok(context.length<25000);assert.ok(context.includes('quoted historical context'));assert.ok(!context.includes('must-not-'));assert.ok(!context.includes('quota failure'));
 assert.equal(continuationContext([]),'');assert.equal(messages[3].text.length,50000);
});

test('local continuation preserves the initial task goal as well as recent progress',()=>{
 const history=[{role:'user',text:'最初目標：製作課程安排 App'}];for(let i=0;i<35;i++)history.push({role:'assistant',text:`進度 ${i}: `+'內容'.repeat(800),status:i===34?'cancelled':'completed'});
 const context=continuationContext(history);assert.match(context,/最初目標：製作課程安排 App/);assert.match(context,/進度 34/);assert.ok(context.length<25000);
});
