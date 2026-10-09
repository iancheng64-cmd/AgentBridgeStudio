import { profileRuntimePlatform, type RuntimePlatform } from './host-platform';
export interface CredentialProfile {id:string;name:string;host:string;port:number;username:string;authType:'agent'|'key'|'password';keyPath?:string;savePassword?:boolean;encryptedPassword?:string;password?:string;hasSavedPassword?:boolean;networkMode?:'auto'|'direct'|'relay';relayUrl?:string;runtimePlatform?:RuntimePlatform;claudeConfigDir?:string}
export function sameCredentialTarget(a:CredentialProfile,b:CredentialProfile){return a.host.trim().toLowerCase()===b.host.trim().toLowerCase()&&(a.port||22)===(b.port||22)&&a.username===b.username&&a.authType===b.authType;}
export function publicProfile(profile:CredentialProfile){const {password,encryptedPassword,...value}=profile;return{...value,hasSavedPassword:!!encryptedPassword};}
export function saveCredentialProfile(incoming:CredentialProfile,previous:CredentialProfile|undefined,encrypt:(value:string)=>string,encryptionAvailable:boolean):CredentialProfile{
 const profile:CredentialProfile={id:incoming.id,name:incoming.name,host:incoming.host.trim(),port:incoming.port||22,username:incoming.username,authType:incoming.authType,keyPath:incoming.keyPath,networkMode:incoming.networkMode||'auto',relayUrl:incoming.relayUrl?.trim()||undefined,claudeConfigDir:incoming.claudeConfigDir?.trim()||undefined,savePassword:incoming.savePassword===true,runtimePlatform:profileRuntimePlatform(incoming.runtimePlatform===undefined?previous||{}:incoming)};
 if(!profile.id||(!profile.host||!profile.username)&&!(profile.networkMode!=='direct'&&profile.relayUrl))throw new Error('請填入完整的連線設定。');
 if(profile.savePassword&&profile.authType==='password'){
  if(incoming.password){if(!encryptionAvailable)throw new Error('macOS 加密儲存目前不可用，未儲存密碼。');profile.encryptedPassword=encrypt(incoming.password);}
  else if(previous?.encryptedPassword&&sameCredentialTarget(profile,previous))profile.encryptedPassword=previous.encryptedPassword;
 }
 return profile;
}
export function savedCredentialFor(incoming:CredentialProfile,profiles:CredentialProfile[]){const saved=profiles.find(profile=>profile.id===incoming.id);return saved?.savePassword&&saved.encryptedPassword&&sameCredentialTarget(saved,incoming)?saved:undefined;}
