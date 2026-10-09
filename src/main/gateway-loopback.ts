/** Loaded only in the App-owned Supergateway subprocess. Its CLI lacks a host flag. */
import net from 'node:net';
const original=net.Server.prototype.listen;
(net.Server.prototype as any).listen=function(...args:any[]){
  if(typeof args[0]==='number'){
    if(typeof args[1]==='string'&&args[1]!=='127.0.0.1')throw new Error('Gateway must remain on IPv4 loopback');
    if(typeof args[1]!=='string')args.splice(1,0,'127.0.0.1');
  }else if(args[0]&&typeof args[0]==='object'&&'port' in args[0]){
    if(args[0].host&&args[0].host!=='127.0.0.1')throw new Error('Gateway must remain on IPv4 loopback');
    args[0]={...args[0],host:'127.0.0.1'};
  }else throw new Error('Unsupported gateway listener');
  return (original as any).apply(this,args);
};
