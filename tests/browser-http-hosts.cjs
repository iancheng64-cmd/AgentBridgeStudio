const {test}=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const http=require('node:http');
const {spawn}=require('node:child_process');
const path=require('node:path');
const {browserHttpAllowedHosts}=require('../dist-main/http-tool-health');

test('real Playwright HTTP accepts the configured host with port and rejects unrelated hosts',async()=>{
  const socket=net.createServer();
  await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  const allowed=browserHttpAllowedHosts('127.0.0.1',port);
  const child=spawn(process.execPath,[path.resolve('node_modules/@playwright/mcp/cli.js'),
    '--host','127.0.0.1','--port',String(port),'--allowed-hosts',allowed,'--headless','--isolated'],
    {stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  const base=`http://127.0.0.1:${port}/mcp`;
  let client,transport;
  try{
    let ready=false;
    for(let i=0;i<60;i++){
      try{const response=await fetch(base,{signal:AbortSignal.timeout(1000)});if(response.status!==403){ready=true;break;}}
      catch{}
      if(child.exitCode!==null)throw new Error(`Playwright exited: ${logs}`);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(ready,true,logs);
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
    const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    transport=new StreamableHTTPClientTransport(new URL(base));
    client=new Client({name:'host allowlist regression',version:'1'});
    await client.connect(transport,{timeout:3000});
    const tools=await client.listTools();
    assert.ok(tools.tools.some(tool=>tool.name==='browser_tabs'));
    const forbidden=await new Promise((resolve,reject)=>{
      const request=http.get(base,{headers:{Host:`unrelated.invalid:${port}`}},response=>{
        response.resume();resolve(response.statusCode);
      });
      request.on('error',reject);request.setTimeout(1000,()=>request.destroy(new Error('HTTP timeout')));
    });
    assert.equal(forbidden,403);
  }finally{
    if(transport)await transport.terminateSession().catch(()=>{});
    if(client)await client.close();
    if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
  }
});
