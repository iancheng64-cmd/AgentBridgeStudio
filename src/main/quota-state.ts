import type { rateLimitSummary } from './runtime-usage';
export type AccountQuota = ReturnType<typeof rateLimitSummary> & {error?:string;lastKnown?:ReturnType<typeof rateLimitSummary>;resetBaseline?:boolean};
interface QuotaRequest {runtimeId:string;revision:number;sequence:number}
/** A selected Runtime owns its snapshots. Events supersede pending reads. */
export class RuntimeQuotaState {
  private runtimeId?:string;
  private revision=0;
  private sequence=0;
  private quota?:AccountQuota;
  private baseline?:AccountQuota;
  private busy=false;
  select(runtimeId?:string){
    if(runtimeId!==this.runtimeId){this.runtimeId=runtimeId;this.revision++;this.quota=undefined;this.baseline=undefined;this.busy=false;}
  }
  get view(){return{runtimeId:this.runtimeId,quota:this.quota,baseline:this.baseline,busy:this.busy};}
  begin():QuotaRequest|undefined {
    if(!this.runtimeId||this.busy)return;
    this.busy=true;return{runtimeId:this.runtimeId,revision:this.revision,sequence:++this.sequence};
  }
  complete(request:QuotaRequest,value:AccountQuota){
    if(request.runtimeId!==this.runtimeId||request.revision!==this.revision||request.sequence!==this.sequence)return false;
    this.busy=false;this.apply(value);return true;
  }
  receive(runtimeId:string,value:AccountQuota){
    if(runtimeId!==this.runtimeId)return false;
    this.revision++;this.busy=false;this.apply(value);return true;
  }
  private apply(value:AccountQuota){
    if(value.resetBaseline)this.baseline=undefined;
    if(value.available&&!this.baseline)this.baseline=value;
    this.quota=value;
  }
}
