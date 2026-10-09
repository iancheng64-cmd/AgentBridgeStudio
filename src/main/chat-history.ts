import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export interface StoredChat { id:string; title:string; messages:unknown[]; [key:string]:unknown }
const validChat=(value:any):value is StoredChat=>value&&typeof value.id==='string'&&value.id.length>0&&value.id.length<=200&&typeof value.title==='string'&&Array.isArray(value.messages);
/** Save only changed conversations. Atomic files avoid localStorage's small quota. */
export class ChatHistoryStore {
 private pending:Promise<unknown>=Promise.resolve();
 constructor(private directory:string){}
 private file(id:string){return path.join(this.directory,createHash('sha256').update(id).digest('hex')+'.json');}
 private async atomic(file:string,value:unknown){const temporary=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,JSON.stringify(value),{mode:0o600});await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}}
 private async readIndex(){
  let ids:unknown;try{ids=JSON.parse(await fs.readFile(path.join(this.directory,'index.json'),'utf8'));}catch(e:any){if(e.code==='ENOENT')return null;throw new Error('對話索引無法讀取，原始檔案已保留。');}
  if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(ids).size!==ids.length)throw new Error('對話索引格式錯誤，原始檔案已保留。');
  return ids as string[];
 }
 private async read(){
  const ids=await this.readIndex();if(ids===null)return null;
  const chats:StoredChat[]=[];for(const id of ids){const chat=JSON.parse(await fs.readFile(this.file(id),'utf8'));if(!validChat(chat)||chat.id!==id)throw new Error('對話檔案格式錯誤，原始檔案已保留。');chats.push(chat);}return chats;
 }
 load(){return this.pending.then(()=>this.read());}
 save(input:{ids:string[];changes:StoredChat[]}){
  const run=async()=>{
   if(!input||!Array.isArray(input.ids)||input.ids.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(input.ids).size!==input.ids.length||!Array.isArray(input.changes)||input.changes.some(chat=>!validChat(chat)||!input.ids.includes(chat.id)))throw new Error('對話儲存格式錯誤。');
   const existing=await this.readIndex();const known=new Set(existing||[]);for(const chat of input.changes)known.add(chat.id);if(input.ids.some(id=>!known.has(id)))throw new Error('缺少對話內容，未覆寫原有索引。');
   await fs.mkdir(this.directory,{recursive:true,mode:0o700});
   for(const chat of input.changes)await this.atomic(this.file(chat.id),chat);
   await this.atomic(path.join(this.directory,'index.json'),input.ids);
   for(const id of existing||[])if(!input.ids.includes(id))await fs.rm(this.file(id),{force:true});
   return {saved:true};
  };
  const result=this.pending.then(run);this.pending=result.catch(()=>{});return result;
 }
 idle(){return this.pending;}
}
