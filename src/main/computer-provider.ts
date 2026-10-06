import fs from 'node:fs';
import path from 'node:path';
import type {LocalToolCommand} from './local-tool-stdio';
export type ComputerProvider='bundled'|'open-computer-use';
/** Only two explicit providers; never interpret a saved command as a shell or silently fall back. */
export class ComputerProviderStore {
  private selected:ComputerProvider;
  constructor(private file:string,private bundled:string,private home:string){
    this.selected='bundled';
    try{const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.provider!=='bundled'&&value.provider!=='open-computer-use')throw new Error('Invalid provider');this.selected=value.provider;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('電腦工具來源設定損壞；未啟動替代來源。');}
  }
  private external(){return path.join(this.home,'.hermes/node/lib/node_modules/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse');}
  private executable(file:string){try{fs.accessSync(file,fs.constants.X_OK);return fs.statSync(file).isFile();}catch{return false;}}
  status(){return {provider:this.selected,label:this.selected==='bundled'?'內建 Computer Use':'Open Computer Use（既有安裝）',externalAvailable:this.executable(this.external()),command:this.selected==='bundled'?this.bundled:this.external()};}
  command():LocalToolCommand{const command=this.selected==='bundled'?this.bundled:this.external();if(!this.executable(command))throw new Error('所選電腦工具執行檔不存在或不能執行；請明確選擇另一個來源。');return {command,args:this.selected==='bundled'?[]:['mcp'],computerProvider:this.selected};}
  select(value:unknown){if(value!=='bundled'&&value!=='open-computer-use')throw new Error('電腦工具來源無效。');const command=value==='bundled'?this.bundled:this.external();if(!this.executable(command))throw new Error('所選電腦工具尚未安裝或不能執行。');fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file,JSON.stringify({provider:value},null,2),{mode:0o600});this.selected=value;return this.status();}
}
