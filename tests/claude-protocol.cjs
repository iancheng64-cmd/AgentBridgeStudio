const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {ClaudeLocalProtocol}=require('../dist-main/claude-local-protocol');
class Transport extends EventEmitter{writes=[];write(line){this.writes.push(JSON.parse(line));}}
test('native control protocol correlates out-of-order replies and split UTF-8 stream, without mixing agent text',async()=>{
 const t=new Transport(),p=new ClaudeLocalProtocol(t);const events=[];p.on('message',e=>events.push(e));const first=p.request('initialize'),second=p.request('mcp_status');
 for(const [index,value] of [[1,{mcpServers:[]}],[0,{commands:[{name:'native'}]}]])t.emit('data',JSON.stringify({type:'control_response',response:{subtype:'success',request_id:t.writes[index].request_id,response:value}})+'\n');
 assert.deepEqual(await first,{commands:[{name:'native'}]});assert.deepEqual(await second,{mcpServers:[]});
 const bytes=Buffer.from(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'繁體中文'}]}})+'\n');for(let i=0;i<bytes.length;i++)t.emit('data',bytes.subarray(i,i+1));assert.equal(events[0].message.content[0].text,'繁體中文');
 p.user([{type:'text',text:'test'}],'fixture-session');assert.equal(t.writes.at(-1).message.role,'user');p.close();
});
test('malformed protocol closes pending control requests and rejects new writes',async()=>{
 const t=new Transport(),p=new ClaudeLocalProtocol(t);const pending=p.request('initialize');t.emit('data','invalid json\n');await assert.rejects(pending,/JSON/);await assert.rejects(p.request('mcp_status'),/關閉/);assert.throws(()=>p.user([]),/關閉/);
});
