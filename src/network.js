// Thin wrapper around PeerJS for a single 1:1 P2P connection.
// PeerJS's free public cloud broker is only used for signaling (finding the
// other peer) - once connected, game data flows directly browser-to-browser
// over WebRTC, so this works fine from a static GitHub Pages site.

export class PeerNetwork extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.conn = null;
    this.role = null; // 'host' | 'client'
  }

  host(existingId) {
    this.role = 'host';
    return new Promise((resolve, reject) => {
      this.peer = new Peer(existingId || shortId());

      this.peer.on('open', (id) => resolve(id));

      this.peer.on('connection', (conn) => {
        if (this.conn) {
          // Already paired up on this id (relevant for autoMode's shared
          // lobby id, where a 3rd person can reach a full match) - reject
          // instead of stealing the slot from the existing pairing.
          conn.close();
          return;
        }
        // 'connection' fires as soon as the DataConnection is being set up,
        // not once the channel can actually send/receive - binding (and
        // sending 'init') before conn.open is true means send() silently
        // drops it, leaving the joiner stuck with no match ever started.
        conn.on('open', () => {
          this._bindConnection(conn);
        });
      });

      this.peer.on('error', (err) => {
        reject(err);
        this.dispatchEvent(new CustomEvent('error', { detail: err }));
      });
    });
  }

  join(hostId, timeoutMs = 12000) {
    this.role = 'client';
    return new Promise((resolve, reject) => {
      this.peer = new Peer();

      this.peer.on('open', () => {
        const conn = this.peer.connect(hostId, { reliable: true });
        let settled = false;

        conn.on('open', () => {
          settled = true;
          this._bindConnection(conn);
          resolve();
        });

        conn.on('error', (err) => {
          if (!settled) reject(err);
        });

        setTimeout(() => {
          if (!settled) reject(new Error('Connection timed out. Check the room code.'));
        }, timeoutMs);
      });

      this.peer.on('error', (err) => {
        reject(err);
      });
    });
  }

  _bindConnection(conn) {
    this.conn = conn;

    conn.on('data', (data) => {
      this.dispatchEvent(new CustomEvent('data', { detail: data }));
    });

    conn.on('close', () => {
      this.dispatchEvent(new CustomEvent('close'));
    });

    conn.on('error', (err) => {
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    });

    this.dispatchEvent(new CustomEvent('connected'));
  }

  send(msg) {
    if (this.conn && this.conn.open) {
      this.conn.send(msg);
    }
  }

  destroy() {
    if (this.conn) this.conn.close();
    if (this.peer) this.peer.destroy();
    this.conn = null;
    this.peer = null;
  }
}

function shortId() {
  // Human-friendly 6-character room code instead of PeerJS's default UUID.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return `room-${out}`;
}

export function formatRoomCode(peerId) {
  return peerId.replace('room-', '');
}

export function toPeerId(roomCode) {
  const trimmed = roomCode.trim().toUpperCase();
  return trimmed.startsWith('ROOM-') ? `room-${trimmed.slice(5)}` : `room-${trimmed}`;
}
