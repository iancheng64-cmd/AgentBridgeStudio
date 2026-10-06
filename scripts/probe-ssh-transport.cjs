const { Server, Client } = require('ssh2');
const { generateKeyPairSync } = require('node:crypto');
const net = require('node:net');
// Isolated localhost SSH server for exercising the production reverse-forward path.
// The generated host key and test authentication exist only for this process.
async function openSshLoopback() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type:'pkcs1', format:'pem' }, publicKeyEncoding:{type:'pkcs1',format:'pem'} });
  const forwards = new Map(); const peers = new Set(); const sockets = new Set();
  const server = new Server({ hostKeys:[privateKey] }, peer => {
    peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer));
    peer.on('authentication', context => context.username === 'agentbridge-probe' && context.method === 'none' ? context.accept() : context.reject());
    peer.on('ready', () => peer.on('request', (accept, reject, name, info) => {
      if (name === 'tcpip-forward' && info.bindAddr === '127.0.0.1' && info.bindPort === 0) {
        const listener = net.createServer(socket => {
          sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
          const port = listener.address().port;
          peer.forwardOut('127.0.0.1', port, socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, (error, stream) => {
            if (error) { socket.destroy(); return; }
            stream.on('error', () => socket.destroy()); stream.on('close', () => socket.destroy()); socket.on('close', () => stream.destroy());
            socket.pipe(stream).pipe(socket);
          });
        });
        listener.once('error', reject); listener.listen(0,'127.0.0.1', () => { forwards.set(listener.address().port, listener); accept(listener.address().port); });
      } else if (name === 'cancel-tcpip-forward') { forwards.get(info.bindPort)?.close(); forwards.delete(info.bindPort); accept(); }
      else reject();
    }));
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const conn = new Client();
  await new Promise((resolve,reject) => {conn.once('ready',resolve);conn.once('error',reject);conn.connect({host:'127.0.0.1',port:server.address().port,username:'agentbridge-probe',tryKeyboard:false});});
  conn.on('error', () => {});
  return { conn, close: async () => {conn.end(); for(const socket of sockets) socket.destroy(); for(const listener of forwards.values()) listener.close(); for(const peer of peers) peer.end(); await new Promise(resolve => server.close(resolve));} };
}
module.exports = { openSshLoopback };
