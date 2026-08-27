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
  repair: { name: 'Repair Car', target: null, persistent: true, desc: 'Couples on: heals 1 HP every round' },
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

// Passing: shuffle the current hand back into the deck, then draw a fresh one.
export function redrawHand(deck, hand, handSize = 3) {
  deck.pile = shuffle(deck.pile.concat(hand), deck.rng);
  const newHand = [];
  for (let i = 0; i < handSize; i++) newHand.push(draw(deck));
  return newHand;
}

function isPlayable(state, side, cardId) {
  const card = CARDS[cardId];
  if (!card.target) return true;
  return validTargets(state, side, cardId).length > 0;
}

// Guarantees at least one playable card in hand, whenever the deck can supply
// one: if every card is currently unplayable (a targeted card with nothing to
// target), keep drawing until a playable one turns up and swap it in. Draws
// that don't help go back to the bottom of the pile rather than being lost.
export function ensurePlayable(state, side, deck, hand) {
  if (hand.some((c) => isPlayable(state, side, c))) return hand;

  const rejected = [];
  let found = null;
  for (let i = 0; i < 20 && found === null; i++) {
    const candidate = draw(deck);
    if (isPlayable(state, side, candidate)) found = candidate;
    else rejected.push(candidate);
  }
  deck.pile = rejected.concat(deck.pile);
  if (found === null) return hand;

  const newHand = hand.slice();
  newHand[newHand.findIndex((c) => !isPlayable(state, side, c))] = found;
  return newHand;
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

const SIDES = ['host', 'client'];

// Round resolution is split into three stages so the UI can animate each one
// separately: setup (claw/sabotage/overcharge/reinforce + new cars coupling
// on) resolves first, then healing, then damage. Each stage mutates `state`
// in place and returns its own log lines; run identically on both peers.

export function resolveSetup(state, plays) {
  const log = [];

  for (const s of SIDES) for (const car of state[s].cars) car.disabledThisRound = false;
  for (const s of SIDES) if (plays[s].card === null) log.push(`${s} passes`);

  // claw / sabotage / overcharge / reinforce
  for (const s of SIDES) {
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
        if (car.type === 'repair') car.healPerRound += 1;
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

  // new cars couple on (confirms whatever the UI already previewed)
  for (const s of SIDES) {
    const play = plays[s];
    if (play.card === 'armor') {
      state.carCounter++;
      state[s].cars.push({ id: state.carCounter, type: 'armor', blockCharges: 1, protected: false, disabledThisRound: false });
      log.push(`${s} couples an Armor Car`);
    } else if (play.card === 'wagon') {
      state.carCounter++;
      state[s].cars.push({ id: state.carCounter, type: 'wagon', dmgPerRound: 1, protected: false, disabledThisRound: false });
      log.push(`${s} couples an Artillery Wagon`);
    } else if (play.card === 'repair') {
      state.carCounter++;
      state[s].cars.push({ id: state.carCounter, type: 'repair', healPerRound: 1, protected: false, disabledThisRound: false });
      log.push(`${s} couples a Repair Car`);
    }
  }

  return log;
}

// Every coupled, non-disabled Repair Car heals its healPerRound each round -
// same trigger pattern as Artillery Wagon's damage, just healing instead.
export function resolveHeal(state, plays) {
  const log = [];
  for (const s of SIDES) {
    let healAmount = 0;
    for (const car of state[s].cars) {
      if (car.type === 'repair' && !car.disabledThisRound) healAmount += car.healPerRound;
    }
    if (healAmount > 0) {
      const before = state[s].hp;
      state[s].hp = Math.min(MAX_HP, state[s].hp + healAmount);
      const healed = state[s].hp - before;
      if (healed > 0) log.push(`${s} heals ${healed} HP`);
    }
  }
  return log;
}

export function resolveDamage(state, plays) {
  const log = [];

  for (const t of SIDES) {
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

  state.round += 1;
  return log;
}

// Convenience: run all three stages back to back, for tests/simulations that
// don't care about the animated staging the UI does between them.
export function resolveRound(state, plays) {
  state.log = [...resolveSetup(state, plays), ...resolveHeal(state, plays), ...resolveDamage(state, plays)];
  return state;
}

export function checkWinner(state) {
  const hostDead = state.host.hp <= 0;
  const clientDead = state.client.hp <= 0;
  if (!hostDead && !clientDead) return null;
  if (hostDead && clientDead) return 'draw';
  return hostDead ? 'client' : 'host';
}
