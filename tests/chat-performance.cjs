const {test}=require('node:test'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const component=require('./helpers/renderer-loader.cjs').load('StudioUI.tsx');
test('long unclosed Markdown links cannot monopolize the UI thread',async()=>{
 const {MessageBody}=await component;const text='['.repeat(16000),start=performance.now();const output=renderToStaticMarkup(React.createElement(MessageBody,{text}));
 assert.ok(performance.now()-start<250,'16k unfinished link delimiters blocked rendering');
 assert.ok(output.includes('['),'message remains readable');
});
test('very long responses mount a bounded text page without deleting original data',async()=>{
 const {MessageBody}=await component;const text='這是測試的一行。\n'.repeat(20000),start=performance.now();const output=renderToStaticMarkup(React.createElement(MessageBody,{text}));
 assert.ok(output.length<60000,'entire long response was mounted');
 assert.ok(output.includes('下一段'),'remaining content must be accessible');
 assert.ok(performance.now()-start<250,'long response blocked rendering');
});
test('inline markup is preserved, malformed labels remain verbatim, Unicode pages are lossless',async()=>{
 const {inlineTokens,textPages,TEXT_PAGE_CHARS,messageWindow,StreamTextBatcher}=require('../dist-main/chat-performance');
 assert.deepEqual(inlineTokens('甲 **乙** `丙` [丁](https://example.com)'),[{type:'text',text:'甲 '},{type:'bold',text:'乙'},{type:'text',text:' '},{type:'code',text:'丙'},{type:'text',text:' '},{type:'link',text:'丁',href:'https://example.com'}]);
 const malformed='['.repeat(32000);assert.equal(inlineTokens(malformed).map(t=>t.text).join(''),malformed);
 const text='a'.repeat(TEXT_PAGE_CHARS-1)+'😀'+'\n末尾'.repeat(2000),points=textPages(text);assert.equal(points.slice(0,-1).map((start,i)=>text.slice(start,points[i+1])).join(''),text);assert.ok(points.every(point=>!(text.charCodeAt(point-1)>=0xd800&&text.charCodeAt(point-1)<=0xdbff)));
 assert.deepEqual(messageWindow(1000,null),{start:960,end:1000});assert.deepEqual(messageWindow(1000,960),{start:920,end:960});
 let calls=[];const batch=new StreamTextBatcher(updates=>calls.push(updates),1000);for(let i=0;i<10000;i++)batch.push({chatId:'c',messageId:'m',text:'字',replace:false});assert.equal(calls.length,0);batch.flush();assert.equal(calls.length,1);assert.equal(calls[0][0].text.length,10000);
 batch.push({chatId:'c',messageId:'m',text:'old',replace:false});batch.push({chatId:'c',messageId:'m',text:'完整',replace:true});batch.push({chatId:'c',messageId:'m',text:'答案',replace:false});batch.flush();assert.deepEqual(calls[1],[{chatId:'c',messageId:'m',text:'完整答案',replace:true}]);batch.cancel();
});
