import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {ComputerProvider} from './computer-provider';
import net from 'node:net';
/** Playwright checks the complete Host header, including the listening port. */
export function browserHttpAllowedHosts(host:string,port:number,addresses:string[]=[]){
  const hosts=[...new Set([host,'localhost','127.0.0.1',...addresses])];
  return hosts.flatMap(value=>[value,`${net.isIP(value)===6?`[${value}]`:value}:${port}`]).join(',');
}
export function requireTailnetBinding(mode:string,host:string){
  const octets=host.split('.').map(Number);
  if(mode!=='tailscale'||net.isIP(host)!==4||octets[0]!==100||octets[1]<64||octets[1]>127)throw new Error('HTTP 工具只允許綁定這台 Mac 的 Tailscale 位址；請先選擇可用的 Tailscale 模式。');
}
/** Loopback needs no VPN installation; remote exposure remains Tailnet-only. */
export function requirePrivateHttpBinding(mode:string,host:string){
  if(mode==='localhost'&&host==='127.0.0.1')return;
  requireTailnetBinding(mode,host);
}
/** An actual MCP session and read-only tool call, never a socket/listener-only health claim. */
export async function httpToolHealth(url:string,kind:'computer'|'browser',provider:ComputerProvider='bundled'){
  const transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{redirect:'error'}});
  const client=new Client({name:'AgentBridge HTTP health',version:'0.4.6'});
  client.onerror=()=>{};
  try{
    await client.connect(transport,{timeout:3000});
    const names:string[]=[];let cursor:string|undefined;
    for(let page=0;page<100;page++){
      const listed=await client.listTools(cursor?{cursor}:{},{timeout:3000});names.push(...listed.tools.map(t=>t.name));
      if(!listed.nextCursor)break;if(listed.nextCursor===cursor||page===99)throw new Error('工具清單不完整。');cursor=listed.nextCursor;
    }
    const probe=kind==='browser'?'browser_tabs':provider==='open-computer-use'?'list_apps':'doctor';
    if(!names.includes(probe))throw new Error('HTTP 端點不是所選的工具來源。');
    const result=await client.callTool({name:probe,arguments:kind==='browser'?{action:'list'}:probe==='doctor'?{prompt:false}:{}},undefined,{timeout:8000});
    if(result.isError)throw new Error('HTTP 工具唯讀檢查失敗。');
    if(probe==='doctor'&&!(result.structuredContent as any)?.permissions)throw new Error('HTTP 原生工具未回報診斷結果。');
    return {ok:true,url,source:kind==='computer'?provider:'playwright',probe,toolCount:names.length,tools:names,checkedAt:Date.now()};
  }finally{try{await transport.terminateSession();}catch{}await client.close();}
}
