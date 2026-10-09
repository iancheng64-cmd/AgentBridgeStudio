/** Shared, bounded chat display helpers. Never trim the stored message. */
export interface InlineToken { type:'text'|'bold'|'code'|'link'; text:string; href?:string }
export function inlineTokens(text:string):InlineToken[]{
 const tokens:InlineToken[]=[];let plain=0,i=0,noLinkClose=false,noBoldClose=false,noCodeClose=false;
 const emit=(start:number,end:number,type:InlineToken['type'],content:string,href?:string)=>{if(start>plain)tokens.push({type:'text',text:text.slice(plain,start)});tokens.push({type,text:content,...(href?{href}:{})});plain=end;i=end;};
 while(i<text.length){
  if(text[i]==='['&&!noLinkClose){
   const close=text.indexOf(']',i+1);if(close<0){noLinkClose=true;i++;continue;}
   if(text[close+1]==='('&&(text.startsWith('https://',close+2)||text.startsWith('http://',close+2))){
    const end=text.indexOf(')',close+2);if(end>=0){const href=text.slice(close+2,end);if(/^https?:\/\/[^\s)]+$/.test(href)&&close>i+1){emit(i,end+1,'link',text.slice(i+1,close),href);continue;}}
   }
   // Consume a malformed label once; never rescan its suffix at every '['.
   i=close+1;continue;
  }
  if(text.startsWith('**',i)&&!noBoldClose){const end=text.indexOf('**',i+2);if(end<0)noBoldClose=true;else if(end>i+2){emit(i,end+2,'bold',text.slice(i+2,end));continue;}}
  if(text[i]==='`'&&!noCodeClose){const end=text.indexOf('`',i+1);if(end<0)noCodeClose=true;else if(end>i+1){emit(i,end+1,'code',text.slice(i+1,end));continue;}}
  i++;
 }
 if(plain<text.length)tokens.push({type:'text',text:text.slice(plain)});return tokens;
}
export const TEXT_PAGE_CHARS=24000,TEXT_PAGE_LINES=320,CHAT_PAGE_MESSAGES=40;
export function textPages(text:string):number[]{
 const boundaries=[0];let start=0,lines=0;
 for(let i=0;i<text.length;i++){
  if(text[i]==='\n')lines++;
  if(i+1-start>=TEXT_PAGE_CHARS||lines>=TEXT_PAGE_LINES){
   // Preserve UTF-16 surrogate pairs across page boundaries.
   if(i+1<text.length&&text.charCodeAt(i)>=0xd800&&text.charCodeAt(i)<=0xdbff)i++;
   boundaries.push(i+1);start=i+1;lines=0;
  }
 }
 if(boundaries.at(-1)!==text.length)boundaries.push(text.length);return boundaries;
}
export function messageWindow(length:number,end:number|null){const stop=Math.min(length,Math.max(0,end??length));return{start:Math.max(0,stop-CHAT_PAGE_MESSAGES),end:stop};}
export interface TextUpdate {chatId:string;messageId:string;text:string;replace:boolean}
export class StreamTextBatcher{
 private updates=new Map<string,TextUpdate>();private timer:ReturnType<typeof setTimeout>|undefined;
 constructor(private apply:(updates:TextUpdate[])=>void,private delay=50){}
 push(update:TextUpdate){const key=JSON.stringify([update.chatId,update.messageId]),prior=this.updates.get(key);this.updates.set(key,prior&&!update.replace?{...prior,text:prior.text+update.text}:update);if(!this.timer)this.timer=setTimeout(()=>this.flush(),this.delay);}
 flush(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;if(!this.updates.size)return;const values=[...this.updates.values()];this.updates.clear();this.apply(values);}
 cancel(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.updates.clear();}
}
