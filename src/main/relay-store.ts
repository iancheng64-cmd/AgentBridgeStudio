import fs from 'node:fs';
import path from 'node:path';
import {RelayConnection,relayRequest,relayUrl,type RelayCredential} from './relay-connection';
interface Codec {available():boolean;encrypt(value:string):string;decrypt(value:string):string}
export class RelayStore{
 constructor(private file:string,private codec:Codec){}
 private read():Record<string,{baseUrl:string;runtimeId:string;deviceId:string;encrypted:string}>{try{return JSON.parse(fs.readFileSync(this.file,'utf8'));}catch(e:any){if(e.code==='ENOENT')return{};throw new Error('Relay 設備資料無法讀取，未覆寫既有資料。');}}
 private write(value:unknown){fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});fs.writeFileSync(this.file+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 async pair(profileId:string,url:string,code:string){
  if(!profileId||!this.codec.available())throw new Error('macOS 安全儲存目前不可用，未儲存配對。');
  const baseUrl=relayUrl(url),result=await relayRequest(baseUrl,'/pair',{code});
  if(typeof result.runtimeId!=='string'||typeof result.deviceId!=='string'||typeof result.credential!=='string'||result.credential.length<40)throw new Error('Relay 配對回應無效。');
  const encrypted=this.codec.encrypt(JSON.stringify({baseUrl,...result}));this.write({...this.read(),[profileId]:{baseUrl,runtimeId:result.runtimeId,deviceId:result.deviceId,encrypted}});
  return{paired:true,runtimeId:result.runtimeId,deviceId:result.deviceId};
 }
 credential(profileId:string,url:string):RelayCredential{
  const saved=this.read()[profileId];if(!saved||saved.baseUrl!==relayUrl(url))throw new Error('ERR_AUTH：此設備尚未配對 Relay，請先輸入一次性配對碼。');
  if(!this.codec.available())throw new Error('安全儲存目前不可用，未讀取 Relay 授權。');
  let result:RelayCredential;try{result=JSON.parse(this.codec.decrypt(saved.encrypted));}catch{throw new Error('ERR_AUTH：macOS 無法讀取 Relay 授權，請處理系統提示後重試。');}
  if(result.baseUrl!==saved.baseUrl||result.runtimeId!==saved.runtimeId||result.deviceId!==saved.deviceId)throw new Error('ERR_AUTH：Relay 設備資料不一致。');return result;
 }
 async connect(input:any){const c=new RelayConnection(this.credential(input.profile.id,input.profile.relayUrl));await c.connect();return c.asRuntimeClient();}
 forget(id:string){const value=this.read();delete value[id];this.write(value);}
 async health(id:string,url:string){const start=Date.now(),credential=this.credential(id,url);await relayRequest(credential.baseUrl,'/session',{runtimeId:credential.runtimeId,deviceId:credential.deviceId,credential:credential.credential});return{stage:'HTTPS 與設備驗證',status:'ok',latencyMs:Date.now()-start};}
}
