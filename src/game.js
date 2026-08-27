// Pure game logic for Reroute. No DOM, no networking - deterministic so both
// peers can run the exact same simulation from the same inputs and stay in sync.

export const MAX_HP = 10;
export const SUDDEN_DEATH_START_ROUND = 9;

export const CARDS = {
  track_break: { name: 'Track Break', target: null, persistent: false, desc: '2 dmg now, 1 next round' },
  wagon: { name: 'Artillery Wagon', target: null, persistent: true, desc: 'Couples on: 2 dmg now, 1/round after' },
  claw: { name: 'Wrecking Claw', target: 'enemy_car', persistent: false, desc: "Destroy one of their coupled cars" },
  sabotage: { name: 'Sabotage', target: 'enemy_car', persistent: false, desc: "Disable one of their coupled cars this round" },
  armor: { name: 'Armor Car', target: null, persistent: true, desc: 'Couples on: blocks your next hit(s)' },
  repair: { name: 'Repair Car', target: null, persistent: false, desc: 'Heal 3 HP' },
  overcharge: { name: 'Overcharge', target: 'own_car', persistent: false, desc: 'Upgrade one of your coupled cars' },
  reinforce: { name: 'Reinforced Coupling', target: 'own_car', persistent: false, desc: 'Protect one of your coupled cars' },
};

const CARD_IDS = Object.keys(CARDS);

// mulberry32 - small deterministic PRNG, good enough for shuffling a fair deck.
export function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Two players draw from independently-shuffled copies of the same 8-card
// deck, seeded off one shared match seed - fair, but nothing to card-count.
export function deriveSeed(masterSeed, role) {
  const salt = role === 'host' ? 0x9e3779b9 : 0x85ebca6b;
  return (masterSeed ^ salt) >>> 0;
}

export function createDeck(seed) {
  const rng = makeRng(seed);
  return { rng, pile: shuffle(CARD_IDS, rng) };
}

export function draw(deck) {
  if (deck.pile.length === 0) deck.pile = shuffle(CARD_IDS, deck.rng);
  return deck.pile.pop();
}

export function createMatchState() {
  return {
    round: 1,
    carCounter: 0,
    host: { hp: MAX_HP, cars: [], pendingDot: 0 },
    client: { hp: MAX_HP, cars: [], pendingDot: 0 },
    log: [],
  };
}

function otherSide(side) {
  return side === 'host' ? 'client' : 'host';
}

function findCar(cars, id) {
  return cars.find((c) => c.id === id);
}

function removeCar(cars, id) {
  const i = cars.findIndex((c) => c.id === id);
  if (i !== -1) cars.splice(i, 1);
}

export function validTargets(state, side, cardId) {
  const card = CARDS[cardId];
  if (card.target === 'enemy_car') {
    return state[otherSide(side)].cars.filter((c) => !c.protected).map((c) => c.id);
  }
  if (card.target === 'own_car') {
    if (cardId === 'reinforce') return state[side].cars.filter((c) => !c.protected).map((c) => c.id);
    return state[side].cars.map((c) => c.id);
  }
  return [];
}

// Advances the match by one round given both players' committed plays.
// Mutates and returns `state`. Runs identically on both peers.
export function resolveRound(state, plays) {
  const sides = ['host', 'client'];
  const log = [];

  for (const s of sides) for (const car of state[s].cars) car.disabledThisRound = false;

  // Phase 1 - setup: claw / sabotage / overcharge / reinforce
  for (const s of sides) {
    const play = plays[s];
    const opp = otherSide(s);
    if (play.card === 'claw') {
      const car = findCar(state[opp].cars, play.target);
      if (car && !car.protected) {
        removeCar(state[opp].cars, car.id);
        log.push(`${s} wrecks ${opp}'s ${car.type}`);
      }
    } else if (play.card === 'sabotage') {
      const car = findCar(state[opp].cars, play.target);
      if (car && !car.protected) {
        car.disabledThisRound = true;
        log.push(`${s} sabotages ${opp}'s ${car.type}`);
      }
    } else if (play.card === 'overcharge') {
      const car = findCar(state[s].cars, play.target);
      if (car) {
        if (car.type === 'wagon') car.dmgPerRound += 1;
        if (car.type === 'armor') car.blockCharges += 1;
        log.push(`${s} overcharges their ${car.type}`);
      }
    } else if (play.card === 'reinforce') {
      const car = findCar(state[s].cars, play.target);
      if (car) {
        car.protected = true;
        log.push(`${s} reinforces their ${car.type}`);
      }
    }
  }

  // Phase 2 - self resolution: repair heals now, new cars couple on
  for (const s of sides) {
    const play = plays[s];
    if (play.card === 'repair') {
      state[s].hp = Math.min(MAX_HP, state[s].hp + 3);
      log.push(`${s} repairs 3 HP`);
    } else if (play.card === 'armor') {
      state.carCounter++;
      state[s].cars.push({ id: state.carCounter, type: 'armor', blockCharges: 1, protected: false, disabledThisRound: false });
      log.push(`${s} couples an Armor Car`);
    } else if (play.card === 'wagon') {
      state.carCounter++;
      state[s].cars.push({ id: state.carCounter, type: 'wagon', dmgPerRound: 1, protected: false, disabledThisRound: false });
      log.push(`${s} couples an Artillery Wagon`);
    }
  }

  // Phase 3 - damage
  for (const t of sides) {
    const attacker = otherSide(t);
    const attackerPlay = plays[attacker];
    const hits = [];

    if (state[t].pendingDot > 0) {
      hits.push(state[t].pendingDot);
      state[t].pendingDot = 0;
    }
    for (const car of state[attacker].cars) {
      if (car.type === 'wagon' && !car.disabledThisRound) hits.push(car.dmgPerRound);
    }
    let newPendingDot = 0;
    if (attackerPlay.card === 'track_break') {
      hits.push(2);
      newPendingDot = 1;
    }

    const armorCar = state[t].cars.find((c) => c.type === 'armor' && c.blockCharges > 0 && !c.disabledThisRound);
    if (armorCar && hits.length) {
      hits.sort((a, b) => b - a);
      let canceled = 0;
      while (armorCar.blockCharges > 0 && canceled < hits.length) {
        hits[canceled] = 0;
        armorCar.blockCharges--;
        canceled++;
      }
      if (armorCar.blockCharges <= 0) removeCar(state[t].cars, armorCar.id);
    }

    const total = hits.reduce((a, b) => a + b, 0);
    if (total > 0) {
      state[t].hp -= total;
      log.push(`${t} takes ${total} damage`);
    }
    state[t].pendingDot += newPendingDot;
  }

  // Sudden death: escalating chip damage once round 9+ is reached
  if (state.round >= SUDDEN_DEATH_START_ROUND) {
    const chip = state.round - (SUDDEN_DEATH_START_ROUND - 1);
    state.host.hp -= chip;
    state.client.hp -= chip;
    log.push(`Sudden death: both trains take ${chip} damage`);
  }

  state.log = log;
  state.round += 1;
  return state;
}

export function checkWinner(state) {
  const hostDead = state.host.hp <= 0;
  const clientDead = state.client.hp <= 0;
  if (!hostDead && !clientDead) return null;
  if (hostDead && clientDead) return 'draw';
  return hostDead ? 'client' : 'host';
}
