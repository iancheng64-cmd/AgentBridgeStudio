const {test}=require('node:test'),assert=require('node:assert/strict'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const components=require('./helpers/renderer-loader.cjs').load('RuntimeControls.tsx');
const base={agent:'claude',status:'connected',transport:'tailscale-ssh',account:{authenticated:false,verified:true,type:'claude-code'},models:[],capabilities:{localTools:true,reason:'fixture'},claudeConfigDir:'C:\\Users\\fixture\\.claude'};
test('connected Runtime with logged-out account reports blocked chat, not green readiness',async()=>{
 const {RuntimeStatus}=await components;const html=renderToStaticMarkup(React.createElement(RuntimeStatus,{runtime:base,onRefresh:()=>{},busy:false}));
 assert.match(html,/通道已連線 · Claude 未登入/);assert.doesNotMatch(html,/connection-dot online/);
});
test('readiness distinguishes unknown login, missing tools, ready account and closed transport',async()=>{
 const {runtimeReadiness}=await components;
 assert.equal(runtimeReadiness({...base,account:{...base.account,verified:false}}).label,'通道已連線 · 登入待確認');
 assert.equal(runtimeReadiness({...base,account:{...base.account,authenticated:true},capabilities:{localTools:false}}).ready,false);
 assert.equal(runtimeReadiness({...base,account:{...base.account,authenticated:true}}).ready,true);
 assert.equal(runtimeReadiness({...base,status:'closed',account:{...base.account,authenticated:true}}).ready,false);
});
test('blocked chat notice keeps a visible repair path alongside the composer',async()=>{
 const {RuntimeReadinessNotice}=await components;const html=renderToStaticMarkup(React.createElement(RuntimeReadinessNotice,{runtime:base,onRefresh:()=>{},onSettings:()=>{},busy:false}));
 assert.match(html,/草稿會保留/);assert.match(html,/重新檢查登入/);assert.match(html,/連線設定/);assert.match(html,/C:\\Users\\fixture/);
});
