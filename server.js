// Local LAN server for Reroute: serves the game's static files AND hosts its
// own PeerJS signaling server, both on one port - so playing on the same
// network doesn't depend on the public internet or PeerJS's public cloud
// broker at all. Two devices on the same LAN talking to a signaling server
// that's also on that LAN sidesteps the NAT-traversal problems that can hit
// the internet-facing GitHub Pages version (see network.js for details).
import express from 'express';
import http from 'http';
import os from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import { ExpressPeerServer } from 'peer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

// Mounted at /peerjs - network.js points its local-mode Peer connections
// here automatically (it just mirrors whatever host/port loaded the page).
const peerServer = ExpressPeerServer(server, { path: '/', allow_discovery: false });
app.use('/peerjs', peerServer);

app.use(express.static(__dirname));

server.listen(PORT, '0.0.0.0', () => {
  const lanAddress = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i.family === 'IPv4' && !i.internal)?.address;

  console.log(`\nReroute local server running.`);
  console.log(`  On this computer:  http://localhost:${PORT}/local.html`);
  if (lanAddress) {
    console.log(`  From other devices on the same network:  http://${lanAddress}:${PORT}/local.html`);
  } else {
    console.log('  Could not detect a LAN address - make sure this computer is on a network.');
  }
  console.log('');
});
