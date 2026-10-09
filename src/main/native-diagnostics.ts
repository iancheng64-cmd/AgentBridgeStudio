import {LocalToolStdio,type LocalToolCommand} from './local-tool-stdio';
export function nativePermissions(report:any):{accessibility?:boolean;screenRecording?:boolean}{
  const p=report?.permissions;
  return {accessibility:typeof p?.accessibilityTrusted==='boolean'?p.accessibilityTrusted:undefined,screenRecording:typeof p?.screenRecordingTrusted==='boolean'?p.screenRecordingTrusted:undefined};
}
/** Read the selected backend, without borrowing another process's permission result. */
export async function computerReport(client:LocalToolStdio,command:LocalToolCommand,prompt=false){
  if(command.computerProvider==='open-computer-use'){
    if(prompt)throw new Error('Open Computer Use 不提供權限請求；請在 macOS 系統設定管理此工具的授權。');
    const result=await client.call('list_apps',{});if(result?.isError)throw new Error('Open Computer Use 無法讀取應用程式清單。');
    return {source:'open-computer-use',health:{ok:true,probe:'list_apps'},permissionsUnavailable:true};
  }
  const result=await client.call('doctor',{prompt});if(result?.isError||!result?.structuredContent?.permissions)throw new Error('原生工具未回報系統權限。');return {...result.structuredContent,source:'bundled'};
}
/** Probe the same MCP executable and spawning context used by Runtime, never a CLI surrogate. */
export async function probeNativePermissions(command:LocalToolCommand,prompt=false){
  const client=new LocalToolStdio(command,prompt?60_000:10_000);
  try{await client.start();const report=await computerReport(client,command,prompt);return {...report,diagnosticProcess:{pid:client.processId,parentPid:process.pid,detached:command.detached??process.platform!=="win32"}};}
  finally{await client.stop();}
}

/** An App-owned local session for diagnostics while the model Runtime is offline. */
export class StandaloneToolHealth {
  private native?:LocalToolStdio;private browser?:LocalToolStdio;
  private starting?:Promise<void>;private generation=0;
  private tools:string[]=[];
  constructor(private commands:{native:LocalToolCommand;browser:LocalToolCommand}){}
  status(){return {ok:!!this.native?.running&&!!this.browser?.running,computer:this.native?.running?'connected-permissions-unverified':'unavailable',browser:this.browser?.running?'connected-browser-unverified':'unavailable',tools:[...this.tools],computerProvider:this.commands.native.computerProvider||'bundled',unavailable:[]};}
  private start():Promise<void>{
    if(this.starting)return this.starting;if(this.status().ok)return Promise.resolve();
    const pending=(async()=>{
      const generation=this.generation+1;await this.stop();if(generation!==this.generation)throw new Error('本機工具啟動已取消。');
      const native=new LocalToolStdio(this.commands.native,15_000),browser=new LocalToolStdio(this.commands.browser,30_000);this.native=native;this.browser=browser;
      try{const [nativeTools,browserTools]=await Promise.all([native.start(),browser.start()]);if(generation!==this.generation)throw new Error('本機工具啟動已取消。');this.tools=[...nativeTools.map(t=>'mac_computer_'+t.name),...browserTools.map(t=>'mac_browser_'+t.name)];}
      catch(error){await Promise.all([native.stop(),browser.stop()]);throw error;}
    })();
    this.starting=pending;return pending.finally(()=>{if(this.starting===pending)this.starting=undefined;});
  }
  async doctor(){if(!this.native?.running)return undefined;const report=await computerReport(this.native,this.commands.native);return {...report,diagnosticProcess:{pid:this.native.processId,parentPid:process.pid,detached:this.commands.native.detached??process.platform!=="win32"}};}
  async health(){await this.start();const computer=await this.doctor();const result=await this.browser!.call('browser_tabs',{action:'list'});if(result?.isError)throw new Error('瀏覽器分頁讀取失敗。');return {computer,browser:{ok:true},macTools:this.status(),checkedAt:Date.now(),scope:'standalone'};}
  async stop(){this.generation++;this.tools=[];const native=this.native,browser=this.browser;this.native=undefined;this.browser=undefined;await Promise.all([native?.stop(),browser?.stop()]);}
}
