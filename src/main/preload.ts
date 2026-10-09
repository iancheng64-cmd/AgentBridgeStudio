import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("agentBridge", {
  history:{
    loadDrafts:()=>ipcRenderer.invoke('history:loadDrafts'),saveDrafts:(input:unknown)=>ipcRenderer.invoke('history:saveDrafts',input),
    load:()=>ipcRenderer.invoke('history:load'),save:(input:unknown)=>ipcRenderer.invoke('history:save',input),
    flushed:(id:string,ok:boolean)=>ipcRenderer.send('history:flushed',id,ok),
    onFlush:(callback:(id:string)=>void)=>{const handler=(_event:unknown,id:string)=>callback(id);ipcRenderer.on('history:flush',handler);return()=>ipcRenderer.removeListener('history:flush',handler);}
  },
  network:{
    pair:(input:unknown)=>ipcRenderer.invoke('network:pair',input),
    diagnose:(input:unknown)=>ipcRenderer.invoke('network:diagnose',input),
    files:(input:unknown)=>ipcRenderer.invoke('network:files',input),
    transfer:(input:unknown)=>ipcRenderer.invoke('network:transfer',input),
    cancelTransfer:(id:string)=>ipcRenderer.invoke('network:cancelTransfer',id),
    terminal:(input:unknown)=>ipcRenderer.invoke('network:terminal',input),
    terminalWrite:(id:string,text:string)=>ipcRenderer.invoke('network:terminalWrite',id,text),
    terminalClose:(id:string)=>ipcRenderer.invoke('network:terminalClose',id),
    onEvent:(callback:(value:any)=>void)=>{const handler=(_event:unknown,value:any)=>callback(value);ipcRenderer.on('network:event',handler);return()=>ipcRenderer.removeListener('network:event',handler);}
  },
  runtime: {
    connect: (input: unknown) => ipcRenderer.invoke("runtime:connect", input),
    disconnect: (runtimeId: string) => ipcRenderer.invoke("runtime:disconnect", runtimeId),
    permission: (runtimeId:string,mode:string)=>ipcRenderer.invoke("runtime:permission",runtimeId,mode),
    recoverTools: (runtimeId:string)=>ipcRenderer.invoke("runtime:recoverTools",runtimeId),
    status: (runtimeId: string) => ipcRenderer.invoke("runtime:status", runtimeId),
    models: (runtimeId: string) => ipcRenderer.invoke("runtime:models", runtimeId),
    extensions: (runtimeId: string) => ipcRenderer.invoke("runtime:extensions", runtimeId),
    usage: (runtimeId:string)=>ipcRenderer.invoke("runtime:usage",runtimeId),
    send: (input: unknown) => ipcRenderer.invoke("runtime:send", input),
    cancel: (runtimeId: string, requestId: string) => ipcRenderer.invoke("runtime:cancel", runtimeId, requestId),
    respond: (input: unknown) => ipcRenderer.invoke("runtime:respond", input),
    chooseLocalDirectory: () => ipcRenderer.invoke("runtime:chooseLocalDirectory"),
    onEvent: (callback: (payload: any) => void) => {
      const handler = (_event: unknown, payload: any) => callback(payload);
      ipcRenderer.on("runtime:event", handler);
      return () => ipcRenderer.removeListener("runtime:event", handler);
    }
  },
  claude: {
    quota:(id:string)=>ipcRenderer.invoke("claude:quota",id),
    login: (input:unknown)=>ipcRenderer.invoke("claude:login",input),
    connect: (input: unknown) => ipcRenderer.invoke("claude:connect", input),
    disconnect: (runtimeId: string) => ipcRenderer.invoke("claude:disconnect", runtimeId),
    permission: (runtimeId:string,mode:string)=>ipcRenderer.invoke("claude:permission",runtimeId,mode),
    recoverTools: (runtimeId:string)=>ipcRenderer.invoke("claude:recoverTools",runtimeId),
    status: (runtimeId: string) => ipcRenderer.invoke("claude:status", runtimeId),
    models: (runtimeId: string) => ipcRenderer.invoke("claude:models", runtimeId),
    extensions: (runtimeId: string) => ipcRenderer.invoke("claude:extensions", runtimeId),
    send: (input: unknown) => ipcRenderer.invoke("claude:send", input),
    cancel: (runtimeId: string, requestId: string) => ipcRenderer.invoke("claude:cancel", runtimeId, requestId),
    respond: (input: unknown) => ipcRenderer.invoke("claude:respond", input),
    onEvent: (callback: (payload: any) => void) => {
      const handler = (_event: unknown, payload: any) => callback(payload);
      ipcRenderer.on("claude:event", handler);
      return () => ipcRenderer.removeListener("claude:event", handler);
    }
  },
  orchestrator: {
    start: (input: unknown) => ipcRenderer.invoke("orchestrator:start", input),
    cancel: (runId: string) => ipcRenderer.invoke("orchestrator:cancel", runId),
    status: (runId?: string) => ipcRenderer.invoke("orchestrator:status", runId),
    onEvent: (callback: (payload: any) => void) => {
      const handler = (_event: unknown, payload: any) => callback(payload);
      ipcRenderer.on("orchestrator:event", handler);
      return () => ipcRenderer.removeListener("orchestrator:event", handler);
    }
  },
  chat: {
    send: (input: unknown) => ipcRenderer.invoke("chat:send", input),
    cancel: (requestId: string) => ipcRenderer.invoke("chat:cancel", requestId),
    onEvent: (callback: (payload: any) => void) => {
      const handler = (_event: unknown, payload: any) => callback(payload);
      ipcRenderer.on("chat:event", handler);
      return () => ipcRenderer.removeListener("chat:event", handler);
    }
  },
  library: {
    list: () => ipcRenderer.invoke("library:list"),
    choose: () => ipcRenderer.invoke("library:choose"),
    addPaths: (paths: string[]) => ipcRenderer.invoke("library:addPaths", paths),
    addImage: (dataUrl: string) => ipcRenderer.invoke("library:addImage", { dataUrl }),
    preview: (id: string) => ipcRenderer.invoke("library:preview", id),
    remove: (id: string) => ipcRenderer.invoke("library:remove", id),
    upload: (sessionId: string, ids: string[], remoteDir?: string) => ipcRenderer.invoke("library:upload", sessionId, ids, remoteDir)
  },
  extensions: { list: (sessionId?: string) => ipcRenderer.invoke("extensions:list", sessionId),loginMcp:(id:string)=>ipcRenderer.invoke('extensions:loginMcp',id) },
  profiles: {
    list: () => ipcRenderer.invoke("profiles:list"),
    save: (profile: unknown) => ipcRenderer.invoke("profiles:save", profile),
    delete: (id: string) => ipcRenderer.invoke("profiles:delete", id)
  },
  ssh: {
    onClosed: (callback: (payload: { sessionId: string }) => void) => {
      const handler = (_event: unknown, payload: { sessionId: string }) => callback(payload);
      ipcRenderer.on("ssh:closed", handler);
      return () => ipcRenderer.removeListener("ssh:closed", handler);
    },
    connect: (payload: unknown) => ipcRenderer.invoke("ssh:connect", payload),
    disconnect: (sessionId: string) => ipcRenderer.invoke("ssh:disconnect", sessionId),
    exec: (sessionId: string, command: string) => ipcRenderer.invoke("ssh:exec", sessionId, command)
  },
  terminal: {
    start: (sessionId: string, initialCommand?: string) => ipcRenderer.invoke("terminal:start", sessionId, initialCommand),
    input: (sessionId: string, data: string) => ipcRenderer.invoke("terminal:input", sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke("terminal:resize", sessionId, cols, rows),
    onData: (callback: (payload: { sessionId: string; data: string }) => void) => {
      const handler = (_event: unknown, payload: { sessionId: string; data: string }) => callback(payload);
      ipcRenderer.on("terminal:data", handler);
      return () => ipcRenderer.removeListener("terminal:data", handler);
    },
    onClosed: (callback: (payload: { sessionId: string }) => void) => {
      const handler = (_event: unknown, payload: { sessionId: string }) => callback(payload);
      ipcRenderer.on("terminal:closed", handler);
      return () => ipcRenderer.removeListener("terminal:closed", handler);
    }
  },
  oauth: {
    forward: (sessionId: string, port: number) => ipcRenderer.invoke("oauth:forward", sessionId, port),
    list: (sessionId: string) => ipcRenderer.invoke("oauth:forwards", sessionId),
    close: (sessionId: string, port: number) => ipcRenderer.invoke("oauth:close", sessionId, port)
  },
  exposure: {
    get: () => ipcRenderer.invoke("exposure:get"),
    set: (mode: "tailscale" | "lan" | "all" | "localhost") => ipcRenderer.invoke("exposure:set", mode)
  },
  files: {
    list: (sessionId: string, remotePath?: string) => ipcRenderer.invoke("files:list", sessionId, remotePath),
    upload: (sessionId: string, remoteDir: string) => ipcRenderer.invoke("files:upload", sessionId, remoteDir),
    uploadFolder: (sessionId: string, remoteDir: string) => ipcRenderer.invoke("files:uploadFolder", sessionId, remoteDir),
    uploadPaths: (sessionId: string, remoteDir: string, localPaths: string[]) => ipcRenderer.invoke("files:uploadPaths", sessionId, remoteDir, localPaths),
    download: (sessionId: string, remotePath: string) => ipcRenderer.invoke("files:download", sessionId, remotePath),
    transfers: (sessionId?: string) => ipcRenderer.invoke("files:transfers", sessionId),
    transferControl: (transferId: string, action: "pause" | "resume" | "cancel" | "clear" | "retry") =>
      ipcRenderer.invoke("files:transferControl", transferId, action),
    pathForFile: (file: File) => webUtils.getPathForFile(file),
    onTransfer: (callback: (payload: unknown) => void) => {
      const handler = (_event: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on("transfer:event", handler);
      return () => ipcRenderer.removeListener("transfer:event", handler);
    },
    onTransferRemoved: (callback: (payload: { id: string }) => void) => {
      const handler = (_event: unknown, payload: { id: string }) => callback(payload);
      ipcRenderer.on("transfer:removed", handler);
      return () => ipcRenderer.removeListener("transfer:removed", handler);
    }
  },
  dialogs: { chooseKey: () => ipcRenderer.invoke("dialog:chooseKey") },
  local: {
    computerProvider:()=>ipcRenderer.invoke("local:computerProvider"),
    selectComputerProvider:(provider:"bundled"|"open-computer-use")=>ipcRenderer.invoke("local:selectComputerProvider",provider),
    network: () => ipcRenderer.invoke("local:network"),
    doctor: (target?:unknown) => ipcRenderer.invoke("local:doctor",target),
    toolHealth: (target?:unknown)=>ipcRenderer.invoke("local:toolHealth",target),
    permissionDiagnostics: ()=>ipcRenderer.invoke("local:permissionDiagnostics"),
    requestPermissions: ()=>ipcRenderer.invoke("local:requestPermissions"),
    stopToolHealth: ()=>ipcRenderer.invoke("local:stopToolHealth"),
    installEngines: () => ipcRenderer.invoke("local:installEngines")
  },
  services: {
    start: (name: "computer" | "browser") => ipcRenderer.invoke("service:start", name),
    stop: (name: string) => ipcRenderer.invoke("service:stop", name),
    status: () => ipcRenderer.invoke("service:status"),
    health:(name:"computer"|"browser")=>ipcRenderer.invoke("service:health",name),
    onEvent: (callback: (payload: unknown) => void) => {
      const handler = (_event: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on("service:event", handler);
      return () => ipcRenderer.removeListener("service:event", handler);
    }
  },
  remote: {
    configureMcp: (sessionId: string, host: string) => ipcRenderer.invoke("remote:configureMcp", sessionId, host),
    extensions: (sessionId: string) => ipcRenderer.invoke("remote:extensions", sessionId)
  },
  system: {
    openExternal: (url: string) => ipcRenderer.invoke("system:openExternal", url),
    reveal: (targetPath: string) => ipcRenderer.invoke("system:reveal", targetPath)
  },
  onToast: (callback: (payload: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("toast", handler);
    return () => ipcRenderer.removeListener("toast", handler);
  }
});
