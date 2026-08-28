// Thin wrapper around PeerJS for a single 1:1 P2P connection.
// PeerJS's free public cloud broker is only used for signaling (finding the
// other peer) - once connected, game data flows directly browser-to-browser
// over WebRTC, so this works fine from a static GitHub Pages site.

// How long to wait for the initial signaling connection (to PeerJS's cloud
// broker) to open, before giving up. Without this, a broker connection that
// never opens - and never fires PeerJS's own 'error' event either, which
// does happen, e.g. some browser privacy/tracking-protection features quietly
// block the WebSocket - leaves host()/join() hanging forever with no
// feedback at all, instead of failing with a message the UI can show.
const SIGNALING_TIMEOUT_MS = 10000;

// STUN alone can't always find a path - two peers behind the SAME router
// (e.g. two devices on one home WiFi) sometimes can't reach each other
// directly OR via STUN, because it needs "NAT hairpinning" that not every
// consumer router supports. A TURN relay is the fallback for exactly that
// case. openrelay.metered.ca's credentials are publicly published for
// free/test use (see their docs) - fine for a hobby project's casual/
// same-WiFi matches, but it's a shared, rate-limited free tier: if this
// ever needs to support many concurrent matches reliably, swap in
// dedicated TURN credentials (Metered, Twilio, or a self-hosted coturn).
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
const PEER_OPTIONS = { config: { iceServers: ICE_SERVERS } };

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
      this.peer = new Peer(existingId || shortId(), PEER_OPTIONS);
      let settled = false;

      const signalingTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Couldn't reach the matchmaking server. Check your connection, or that no browser extension/security software is blocking it, and try again."));
      }, SIGNALING_TIMEOUT_MS);

      this.peer.on('open', (id) => {
        if (settled) return;
        settled = true;
        clearTimeout(signalingTimeout);
        resolve(id);
      });

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
        if (!settled) {
          settled = true;
          clearTimeout(signalingTimeout);
          reject(err);
        }
        this.dispatchEvent(new CustomEvent('error', { detail: err }));
      });
    });
  }

  join(hostId, timeoutMs = 12000) {
    this.role = 'client';
    return new Promise((resolve, reject) => {
      this.peer = new Peer(undefined, PEER_OPTIONS);
      let settled = false;

      const signalingTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Couldn't reach the matchmaking server. Check your connection, or that no browser extension/security software is blocking it, and try again."));
      }, SIGNALING_TIMEOUT_MS);

      this.peer.on('open', () => {
        if (settled) return; // the signaling timeout already fired
        clearTimeout(signalingTimeout);
        const conn = this.peer.connect(hostId, { reliable: true });

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
        if (!settled) {
          settled = true;
          clearTimeout(signalingTimeout);
          reject(err);
        }
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
