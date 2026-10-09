export {};

export type ExposureMode = "tailscale" | "lan" | "all" | "localhost";
export interface ExposureState { mode: ExposureMode; bindHost: string; advertiseHost: string; note?: string }
export interface DoctorCheck { id: string; label: string; state: "ok" | "warn" | "fail" | "unknown"; detail: string; hint?: string }
export interface DoctorReport { checks: DoctorCheck[]; raw: string }

declare global {
  interface Window {
    agentBridge: {
      history:{load():Promise<unknown[]|null>;save(input:{ids:string[];changes:unknown[]}):Promise<{saved:boolean}>;flushed(id:string,ok:boolean):void;onFlush(cb:(id:string)=>void):()=>void};
      network:{pair(input:any):Promise<any>;diagnose(input:any):Promise<any>;files(input:any):Promise<any>;transfer(input:any):Promise<any>;cancelTransfer(id:string):Promise<any>;terminal(input:any):Promise<any>;terminalWrite(id:string,text:string):Promise<any>;terminalClose(id:string):Promise<any>;onEvent(cb:(value:any)=>void):()=>void;};
      runtime: {
        connect(input: { profile: any; password?: string; platform: "auto" | "windows" | "posix"; executable?: string; trustedFingerprint?: string; localCwd?: string; localHostExecutable?: string; permissionMode?: "ask"|"project"|"full"; autoCompactPercent?: number }): Promise<any>;
        disconnect(runtimeId: string): Promise<void>;
        permission(runtimeId:string,mode:"ask"|"project"|"full"):Promise<any>;
        recoverTools(runtimeId:string):Promise<any>;
        status(runtimeId: string): Promise<any>;
        models(runtimeId: string): Promise<any[]>;
        usage(runtimeId:string):Promise<any>;
        extensions(runtimeId:string):Promise<{items:any[];warnings:string[]}>;
        send(input: {runtimeId:string;requestId?:string;prompt:string;conversationId?:string;model?:string;effort?:string;attachments?:string[];localCwd?:string;autoCompactPercent?:number}): Promise<{requestId:string}>;
        cancel(runtimeId: string, requestId: string): Promise<{cancelled:boolean}>;
        respond(input: {runtimeId:string;approvalId:string;decision:"accept"|"decline";answers?:Record<string,string[]>}): Promise<{resolved:boolean}>;
        chooseLocalDirectory(): Promise<string|null>;
        onEvent(cb:(event:any)=>void):()=>void;
      };
      claude: {
        quota(id:string):Promise<any>;
        login(input:{executable?:string}):Promise<{opened:boolean}>;
        connect(input: {profile?:any;password?:string;platform?:"auto"|"windows"|"posix";trustedFingerprint?:string;location?:"remote"|"local";nodeExecutable?:string;remoteCwd?:string;configDir?:string;localCwd:string;executable?:string;permissionMode?:"ask"|"project"|"full";authMode?:"official"|"api";autoCompactPercent?:number;api?:{baseUrl?:string;apiKey?:string;model?:string}}):Promise<any>;
        disconnect(runtimeId:string):Promise<void>;
        permission(runtimeId:string,mode:"ask"|"project"|"full"):Promise<any>;
        recoverTools(runtimeId:string):Promise<any>;
        status(runtimeId:string):Promise<any>;
        models(runtimeId:string):Promise<any[]>;
        extensions(runtimeId:string):Promise<{items:any[];warnings:string[]}>;
        send(input:unknown):Promise<{requestId:string}>;
        cancel(runtimeId:string,requestId:string):Promise<{cancelled:boolean}>;
        respond(input:unknown):Promise<{resolved:boolean}>;
        onEvent(cb:(event:any)=>void):()=>void;
      };
      orchestrator: {
        start(input:{codexRuntimeId:string;claudeRuntimeId:string;topic:string;rounds?:number;leadAgent?:"codex"|"claude";codexModel?:string;claudeModel?:string;codexEffort?:string;claudeEffort?:string}):Promise<{runId:string;conversationId:string;rounds:number;modelCalls:number}>;
        cancel(runId:string):Promise<{cancelled:boolean}>;
        status(runId?:string):Promise<any>;
        onEvent(cb:(event:any)=>void):()=>void;
      };
      chat: {
        send(input: { sessionId: string; agent: "codex" | "claude"; prompt: string; requestId?: string; conversationId?: string; remoteCwd?: string; attachments?: Array<{id:string}>; model?: string }): Promise<{requestId:string}>;
        cancel(requestId: string): Promise<{cancelled:boolean}>;
        onEvent(cb: (payload: {requestId:string;sessionId:string;type:"session"|"delta"|"message"|"activity"|"done"|"error";conversationId?:string;text?:string;itemId?:string;status?:string;code?:number|null}) => void): () => void;
      };
      library: {
        list(): Promise<any[]>;
        choose(): Promise<any[]>;
        addPaths(paths: string[]): Promise<any[]>;
        addImage(dataUrl: string): Promise<any[]>;
        preview(id: string): Promise<string|null>;
        remove(id: string): Promise<any[]>;
        upload(sessionId: string, ids: string[], remoteDir?: string): Promise<any[]>;
      };
      extensions: { list(sessionId?: string): Promise<{items:any[];warnings:string[]}>;loginMcp(id:string):Promise<{opened:boolean;authenticated:boolean}> };
      profiles: {
        list(): Promise<any[]>;
        save(profile: any): Promise<any[]>;
        delete(id: string): Promise<any[]>;
      };
      ssh: {
        onClosed(cb: (payload: {sessionId:string}) => void): () => void;
        connect(payload: any): Promise<any>;
        disconnect(sessionId: string): Promise<void>;
        exec(sessionId: string, command: string): Promise<{stdout:string; stderr:string; code:number|null}>;
      };
      terminal: {
        start(sessionId: string, initialCommand?: string): Promise<void>;
        input(sessionId: string, data: string): Promise<void>;
        resize(sessionId: string, cols: number, rows: number): Promise<void>;
        onData(cb: (payload: {sessionId:string; data:string}) => void): () => void;
        onClosed(cb: (payload: {sessionId:string}) => void): () => void;
      };
      oauth: { forward(sessionId: string, port: number): Promise<{port:number}>; list(sessionId: string): Promise<number[]>; close(sessionId: string, port: number): Promise<{port:number;closed:boolean}> };
      exposure: { get(): Promise<ExposureState>; set(mode: ExposureMode): Promise<ExposureState> };
      files: {
        list(sessionId: string, remotePath?: string): Promise<any[]>;
        upload(sessionId: string, remoteDir: string): Promise<any[]>;
        uploadFolder(sessionId: string, remoteDir: string): Promise<any[]>;
        uploadPaths(sessionId: string, remoteDir: string, localPaths: string[]): Promise<any[]>;
        download(sessionId: string, remotePath: string): Promise<any|null>;
        transfers(sessionId?: string): Promise<any[]>;
        transferControl(transferId: string, action: "pause" | "resume" | "cancel" | "clear" | "retry"): Promise<any|null>;
        pathForFile(file: File): string;
        onTransfer(cb: (payload: any) => void): () => void;
        onTransferRemoved(cb: (payload: { id: string }) => void): () => void;
      };
      dialogs: { chooseKey(): Promise<string|null> };
      local: {
        computerProvider():Promise<{provider:"bundled"|"open-computer-use";label:string;externalAvailable:boolean;command:string}>;
        selectComputerProvider(provider:"bundled"|"open-computer-use"):Promise<any>;
        network(): Promise<Array<{name:string;address:string;kind:string}>>;
        doctor(target?:{runtimeId?:string;provider?:"codex"|"claude"}): Promise<DoctorReport>;
        toolHealth(target?:{runtimeId?:string;provider?:"codex"|"claude";reset?:boolean}):Promise<any>;
        permissionDiagnostics():Promise<any>;
        requestPermissions():Promise<any>;
        stopToolHealth():Promise<void>;
        installEngines(): Promise<any>;
      };
      services: {
        start(name:"computer"|"browser"): Promise<any>;
        stop(name:string): Promise<any>;
        status(): Promise<any[]>;
        health(name:"computer"|"browser"):Promise<any>;
        onEvent(cb:(payload:any)=>void):()=>void;
      };
      remote: {
        configureMcp(sessionId:string,host:string):Promise<{stdout:string;stderr:string;code:number|null}>;
        extensions(sessionId:string):Promise<{stdout:string;stderr:string;code:number|null}>;
      };
      system: {
        openExternal(url:string):Promise<void>;
        reveal(path:string):Promise<void>;
      };
      onToast(cb:(payload:any)=>void):()=>void;
    };
  }
}
