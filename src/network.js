// Thin wrapper around PeerJS for a single 1:1 P2P connection. Signaling
// (finding the other peer) uses PeerJS's free public cloud broker when
// loaded as index.html (fine from a static GitHub Pages site), or this
// project's own self-hosted signaling server (see server.js) when loaded as
// local.html - either way, once connected, game data flows directly
// browser-to-browser over WebRTC.

// How long to wait for the initial signaling connection (to PeerJS's cloud
// broker) to open, before giving up. Without this, a broker connection that
// never opens - and never fires PeerJS's own 'error' event either, which
// does happen, e.g. some browser privacy/tracking-protection features quietly
// block the WebSocket - leaves host()/join() hanging forever with no
// feedback at all, instead of failing with a message the UI can show.
const SIGNALING_TIMEOUT_MS = 10000;

// STUN-only for the internet-facing (index.html) case: a shared public TURN
// relay (openrelay.metered.ca) was tried here to help two devices behind the
// SAME router reach each other, but its free-tier TURN was actively failing
// ICE negotiation ("your TURN server appears to be broken") and made
// connections worse, not better - a broken TURN candidate in the mix can
// disrupt an ICE negotiation that would have succeeded fine on STUN alone.
// Removed rather than leave something actively harmful in place. Two devices
// on the exact same router/WiFi may still fail to connect to each other in
// the rare case that router doesn't support NAT hairpinning - fixing that
// for good on the internet-facing version needs a real (paid) TURN service.
const PUBLIC_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// local.html is served by this project's own local server (see server.js),
// which also hosts a private PeerJS signaling server AND a private TURN
// relay on the same machine - point Peer at both instead of PeerJS's public
// broker and no TURN at all. Even on a LAN, plain STUN isn't always enough:
// browsers obfuscate local candidates via mDNS, which can fail to resolve
// between two devices on a locked-down office WiFi that blocks multicast -
// TURN is the fallback for exactly that, and self-hosting it here means the
// relay never has to leave the LAN either, same as signaling. Credentials
// are just a fixed local secret (see server.js) - fine for a same-network
// dev tool, not meant to be a real access-control boundary.
const TURN_PORT = 3478;
const TURN_USERNAME = 'reroute';
const TURN_PASSWORD = 'reroute-lan';

const useLocalSignaling = location.pathname.endsWith('local.html');

function peerOptions() {
  if (!useLocalSignaling) {
    return { config: { iceServers: PUBLIC_ICE_SERVERS } };
  }
  const iceServers = [
    ...PUBLIC_ICE_SERVERS,
    { urls: `turn:${location.hostname}:${TURN_PORT}`, username: TURN_USERNAME, credential: TURN_PASSWORD },
    { urls: `turn:${location.hostname}:${TURN_PORT}?transport=tcp`, username: TURN_USERNAME, credential: TURN_PASSWORD },
  ];
  return {
    config: { iceServers },
    host: location.hostname,
    port: location.port ? Number(location.port) : location.protocol === 'https:' ? 443 : 80,
    path: '/peerjs',
    secure: location.protocol === 'https:',
  };
}

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
      const peer = new Peer(existingId || shortId(), peerOptions());
      this.peer = peer;
      let settled = false;

      // Giving up (timeout or error) must actually destroy this peer, not
      // just stop listening to it - otherwise an attempt we've abandoned can
      // still finish connecting to the broker moments later in the
      // background and sit there holding its id (e.g. autoMode's shared
      // lobby id) forever, since nothing else ever calls destroy() on it.
      // Every future attempt on that id would then wrongly see it as taken.
      const giveUp = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(signalingTimeout);
        peer.destroy();
        reject(err);
      };

      const signalingTimeout = setTimeout(() => {
        giveUp(new Error("Couldn't reach the matchmaking server. Check your connection, or that no browser extension/security software is blocking it, and try again."));
      }, SIGNALING_TIMEOUT_MS);

      peer.on('open', (id) => {
        if (settled) return;
        settled = true;
        clearTimeout(signalingTimeout);
        resolve(id);
      });

      peer.on('connection', (conn) => {
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

      peer.on('error', (err) => {
        giveUp(err);
        this.dispatchEvent(new CustomEvent('error', { detail: err }));
      });
    });
  }

  join(hostId, timeoutMs = 12000) {
    this.role = 'client';
    return new Promise((resolve, reject) => {
      const peer = new Peer(undefined, peerOptions());
      this.peer = peer;
      let settled = false;

      // See the matching comment in host() - an abandoned attempt must be
      // destroyed, not just ignored, or it can keep connecting in the
      // background after we've already given up on it.
      const giveUp = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(signalingTimeout);
        peer.destroy();
        reject(err);
      };

      const signalingTimeout = setTimeout(() => {
        giveUp(new Error("Couldn't reach the matchmaking server. Check your connection, or that no browser extension/security software is blocking it, and try again."));
      }, SIGNALING_TIMEOUT_MS);

      peer.on('open', () => {
        if (settled) return; // the signaling timeout already fired
        clearTimeout(signalingTimeout);
        const conn = peer.connect(hostId, { reliable: true });

        conn.on('open', () => {
          settled = true;
          this._bindConnection(conn);
          resolve();
        });

        conn.on('error', (err) => {
          giveUp(err);
        });

        setTimeout(() => {
          giveUp(new Error('Connection timed out. Check the room code.'));
        }, timeoutMs);
      });

      peer.on('error', (err) => {
        giveUp(err);
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

// A big list of plain, common 4-letter words - easier to read, say out loud,
// and type correctly than a random string of letters/digits.
const ROOM_WORDS = [
  'ABLE', 'ACHE', 'ACID', 'AREA', 'ARMY', 'AUNT', 'BABY', 'BACK', 'BALL', 'BAND',
  'BANK', 'BARN', 'BASE', 'BATH', 'BEAM', 'BEAN', 'BEAR', 'BEAT', 'BELL', 'BELT',
  'BEND', 'BEST', 'BIKE', 'BILL', 'BIRD', 'BLUE', 'BOAT', 'BODY', 'BOLT', 'BONE',
  'BOOK', 'BOOT', 'BOSS', 'BOWL', 'BUCK', 'BULB', 'BULK', 'BUNK', 'BURN', 'BUSH',
  'BUSY', 'CAFE', 'CAGE', 'CAKE', 'CALM', 'CAMP', 'CANE', 'CAPE', 'CARD', 'CARE',
  'CART', 'CASE', 'CASH', 'CAST', 'CAVE', 'CELL', 'CHAT', 'CHEF', 'CHIN', 'CHIP',
  'CITY', 'CLAM', 'CLAP', 'CLAW', 'CLAY', 'CLIP', 'CLUB', 'CLUE', 'COAL', 'COAT',
  'CODE', 'COIN', 'COLD', 'COLT', 'COMB', 'COOK', 'COOL', 'CORD', 'CORK', 'CORN',
  'COST', 'COVE', 'CRAB', 'CRIB', 'CROP', 'CROW', 'CUBE', 'CUFF', 'CURB', 'CURL',
  'DAWN', 'DEAL', 'DEBT', 'DECK', 'DEEP', 'DEER', 'DENT', 'DESK', 'DIAL', 'DICE',
  'DIME', 'DINE', 'DISC', 'DISH', 'DOCK', 'DOLL', 'DOME', 'DOOR', 'DOSE', 'DOVE',
  'DRUM', 'DUCK', 'DUKE', 'DUNE', 'DUST', 'DUTY', 'EARN', 'EAST', 'EASY', 'ECHO',
  'EDGE', 'EPIC', 'EXIT', 'FACE', 'FACT', 'FADE', 'FAIR', 'FALL', 'FAME', 'FARM',
  'FAST', 'FATE', 'FEED', 'FEEL', 'FERN', 'FILE', 'FILL', 'FILM', 'FIND', 'FINE',
  'FIRE', 'FISH', 'FIST', 'FIVE', 'FLAG', 'FLAT', 'FLEX', 'FLIP', 'FLOW', 'FOAM',
  'FOLD', 'FOLK', 'FOOD', 'FOOT', 'FORK', 'FORM', 'FORT', 'FOUR', 'FUEL', 'FULL',
  'FUND', 'FUSE', 'GAIN', 'GAME', 'GATE', 'GAZE', 'GEAR', 'GENE', 'GIFT', 'GIRL',
  'GLOW', 'GLUE', 'GOAL', 'GOAT', 'GOLD', 'GOLF', 'GOOD', 'GRAB', 'GRAY', 'GRID',
  'GRIN', 'GRIP', 'GROW', 'GULF', 'GUST', 'HAIR', 'HALF', 'HALL', 'HAND', 'HARD',
  'HARE', 'HARM', 'HARP', 'HAWK', 'HAZE', 'HEAD', 'HEAL', 'HEAP', 'HEAT', 'HERB',
  'HERD', 'HERO', 'HIDE', 'HIGH', 'HIKE', 'HILL', 'HINT', 'HIRE', 'HOLD', 'HOLE',
  'HOME', 'HOOD', 'HOOK', 'HOPE', 'HORN', 'HOST', 'HOUR', 'HUGE', 'HULL', 'HUNT',
  'ICON', 'IDEA', 'IDLE', 'INCH', 'IRIS', 'IRON', 'ITEM', 'JADE', 'JAIL', 'JAZZ',
  'JOKE', 'JOLT', 'JUMP', 'JUNK', 'JURY', 'KEEN', 'KELP', 'KICK', 'KIND', 'KING',
  'KITE', 'KNEE', 'KNOT', 'LACE', 'LACK', 'LAKE', 'LAMB', 'LAMP', 'LAND', 'LANE',
  'LAWN', 'LEAD', 'LEAF', 'LEAN', 'LEAP', 'LEFT', 'LEND', 'LENS', 'LIFE', 'LIFT',
  'LIME', 'LINE', 'LINK', 'LION', 'LIST', 'LOAD', 'LOAF', 'LOAN', 'LOCK', 'LOFT',
  'LOGO', 'LONE', 'LONG', 'LOOK', 'LOOP', 'LORD', 'LOSS', 'LOVE', 'LUCK', 'LUMP',
  'LUNG', 'LURE', 'LYNX', 'MAID', 'MAIL', 'MAIN', 'MAKE', 'MALE', 'MALL', 'MANE',
  'MARK', 'MASK', 'MAST', 'MATE', 'MATH', 'MAZE', 'MEAL', 'MEAT', 'MELT', 'MENU',
  'MESH', 'MESS', 'MICE', 'MILD', 'MILE', 'MILK', 'MIND', 'MINE', 'MINT', 'MIST',
  'MOOD', 'MOON', 'MOSS', 'MOTH', 'MOVE', 'MULE', 'MUSE', 'MUSK', 'NAIL', 'NAME',
  'NAVY', 'NEAR', 'NECK', 'NERD', 'NEST', 'NEWS', 'NEXT', 'NICE', 'NINE', 'NOON',
  'NOSE', 'NOTE', 'OATH', 'OKAY', 'OPEN', 'OVAL', 'OVEN', 'PACE', 'PACK', 'PAGE',
  'PAIL', 'PAIN', 'PAIR', 'PALE', 'PALM', 'PANE', 'PARK', 'PART', 'PASS', 'PATH',
  'PEAK', 'PEAR', 'PEEL', 'PEER', 'PICK', 'PIER', 'PILE', 'PILL', 'PINE', 'PINK',
  'PINT', 'PIPE', 'PLAN', 'PLAY', 'PLOT', 'PLOW', 'PLUG', 'PLUM', 'POEM', 'POET',
  'POKE', 'POLE', 'POND', 'POOL', 'PORE', 'PORK', 'PORT', 'POSE', 'POST', 'POUR',
  'PREY', 'PROP', 'PULL', 'PULP', 'PUMP', 'PUNK', 'PURE', 'PUSH', 'QUIZ', 'RACE',
  'RACK', 'RAFT', 'RAGE', 'RAID', 'RAIL', 'RAIN', 'RAKE', 'RAMP', 'RANK', 'RARE',
  'RATE', 'RAVE', 'READ', 'REAL', 'REEF', 'REEL', 'REST', 'RICE', 'RICH', 'RIDE',
  'RING', 'RISE', 'RISK', 'ROAD', 'ROAM', 'ROAR', 'ROBE', 'ROCK', 'ROLE', 'ROLL',
  'ROOF', 'ROOT', 'ROPE', 'ROSE', 'RUBY', 'RULE', 'RUSH', 'RUST', 'SACK', 'SAFE',
  'SAGE', 'SAIL', 'SALE', 'SALT', 'SAME', 'SAND', 'SANE', 'SAVE', 'SCAN', 'SCAR',
  'SEAL', 'SEAM', 'SEAT', 'SEED', 'SEEK', 'SELF', 'SELL', 'SEND', 'SHED', 'SHIP',
  'SHOE', 'SHOP', 'SHOT', 'SHOW', 'SICK', 'SIDE', 'SIGH', 'SIGN', 'SILK', 'SING',
  'SINK', 'SITE', 'SIZE', 'SKIN', 'SKIP', 'SLAB', 'SLED', 'SLIM', 'SLIP', 'SLOT',
  'SLOW', 'SNAP', 'SNOW', 'SOAP', 'SOCK', 'SODA', 'SOFA', 'SOFT', 'SOIL', 'SOLE',
  'SONG', 'SOON', 'SORT', 'SOUL', 'SOUP', 'SOUR', 'SPAN', 'SPIN', 'SPOT', 'STAR',
  'STAY', 'STEM', 'STEP', 'STEW', 'STIR', 'STOP', 'SUIT', 'SURE', 'SWAN', 'SWIM',
  'TAIL', 'TAKE', 'TALE', 'TALK', 'TALL', 'TAME', 'TANK', 'TAPE', 'TASK', 'TEAM',
  'TECH', 'TEEN', 'TELL', 'TENT', 'TERM', 'TEST', 'TEXT', 'THIN', 'TIDE', 'TILE',
  'TIME', 'TINY', 'TIRE', 'TOAD', 'TOES', 'TONE', 'TOOL', 'TOUR', 'TOWN', 'TOYS',
  'TRAP', 'TRAY', 'TREE', 'TRIM', 'TRIP', 'TRUE', 'TUBE', 'TUNE', 'TURN', 'TWIN',
  'UNIT', 'URGE', 'USER', 'VAIN', 'VASE', 'VAST', 'VEIL', 'VEIN', 'VERB', 'VEST',
  'VIEW', 'VINE', 'VOTE', 'WAGE', 'WAIT', 'WAKE', 'WALK', 'WALL', 'WAND', 'WANT',
  'WARD', 'WARM', 'WARN', 'WASH', 'WAVE', 'WEAK', 'WEAR', 'WEED', 'WEEK', 'WELL',
  'WEST', 'WHIM', 'WIDE', 'WIFE', 'WILD', 'WILL', 'WIND', 'WINE', 'WING', 'WINK',
  'WIRE', 'WISE', 'WISH', 'WOLF', 'WOOD', 'WOOL', 'WORD', 'WORK', 'WORM', 'YARD',
  'YARN', 'YEAR', 'ZERO', 'ZEST', 'ZONE', 'ZOOM',
];

function shortId() {
  const word = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
  return `room-${word}`;
}

export function formatRoomCode(peerId) {
  return peerId.replace('room-', '');
}

// Case-insensitive and ignores whitespace anywhere in the input, not just
// leading/trailing - covers a code pasted with stray spaces or typed with
// the wrong shift-lock state.
export function toPeerId(roomCode) {
  const cleaned = roomCode.replace(/\s+/g, '').toUpperCase();
  return cleaned.startsWith('ROOM-') ? `room-${cleaned.slice(5)}` : `room-${cleaned}`;
}
