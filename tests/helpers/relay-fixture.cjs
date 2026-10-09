const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {createGateway,GatewayStore}=require('../../gateway/gateway.cjs');const {relayRequest,RelayConnection}=require('../../dist-main/relay-connection');
exports.fixture=async function(options={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'agentbridge-relay-test-')),key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
 const ca=await fs.readFile(cert,'utf8'),store=new GatewayStore(path.join(root,'state.json')),gateway=createGateway({...options,store,root:options.root||root,tls:{key:await fs.readFile(key),cert:ca}}),port=await gateway.listen(0),base='https://127.0.0.1:'+port;
 const code=store.pairCode(),paired=await relayRequest(base,'/pair',{code},undefined,ca),credential={baseUrl:base,...paired},conn=new RelayConnection(credential,ca);await conn.connect();
 return{root,base,code,ca,store,gateway,conn,credential,request:(route,body,token)=>relayRequest(base,route,body,token,ca),async close(){conn.end();await gateway.close();await fs.rm(root,{recursive:true,force:true});}};
};
