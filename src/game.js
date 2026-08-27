// Pure game logic for Reroute. No DOM, no networking - deterministic so both
// peers can run the exact same simulation from the same inputs and stay in sync.

export const MAX_HP = 10;
export const SUDDEN_DEATH_START_ROUND = 9;

export const CARDS = {
  wagon: { name: 'Artillery Wagon', target: null, persistent: true, weapon: true, desc: 'Couples on: 1 dmg every round' },
  sniper: { name: 'Sniper Car', target: null, persistent: true, weapon: true, desc: 'Couples on: 1 dmg every round, ignores Armor Car' },
  claw: { name: 'Wrecking Car', target: 'enemy_car', persistent: true, desc: 'Couples on, then destroys one of their coupled cars' },
  sabotage: { name: 'Sabotage', target: 'enemy_car', persistent: false, desc: "Disable one of their coupled cars this round" },
  armor: { name: 'Armor Car', target: null, persistent: true, desc: 'Couples on: blocks your next hit(s)' },
  repair: { name: 'Repair Car', target: null, persistent: true, desc: 'Couples on: heals 1 HP every round' },
  overcharge: { name: 'Overcharge', target: 'own_car', persistent: false, desc: 'Upgrade one of your coupled cars' },
  reinforce: { name: 'Reinforced Coupling', target: 'own_car', persistent: false, desc: 'Protect one of your coupled cars' },
  refresh: { name: 'Refresh', target: 'own_car', persistent: false, desc: 'Reactivate one of your spent cars' },
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

// Two players draw from independently-shuffled copies of the same deck (one
// of each card in CARDS), seeded off one shared match seed - fair, but
// nothing to card-count.
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

// Guarantees the opening hand has some way to actually deal damage: if it
// has no weapon (Artillery Wagon / Sniper Car), keep drawing until one turns
// up and swap it in for the first card. Draws that don't help go back to the
// bottom of the pile rather than being lost.
export function ensureWeapon(deck, hand) {
  if (hand.some((c) => CARDS[c].weapon)) return hand;

  const rejected = [];
  let found = null;
  for (let i = 0; i < 20 && found === null; i++) {
    const candidate = draw(deck);
    if (CARDS[candidate].weapon) found = candidate;
    else rejected.push(candidate);
  }
  deck.pile = rejected.concat(deck.pile);
  if (found === null) return hand;

  const newHand = hand.slice();
  newHand[0] = found;
  return newHand;
}

export function createMatchState() {
  return {
    round: 1,
    carCounter: 0,
    host: { hp: MAX_HP, cars: [] },
    client: { hp: MAX_HP, cars: [] },
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

// Inserts a newly-coupled car at a chosen position in the train (the player
// dragged it there); index is clamped to a valid range and defaults to the
// engine end (append) when not given.
function insertCar(cars, car, index) {
  const i = index == null ? cars.length : Math.max(0, Math.min(index, cars.length));
  cars.splice(i, 0, car);
}

// A car that's used up whatever made it useful but is still coupled: an
// Armor Car with no charges left, or a Wrecking Car that's already fired.
export function isSpent(car) {
  if (car.type === 'armor') return car.blockCharges <= 0;
  if (car.type === 'claw') return car.fired;
  return false;
}

export function validTargets(state, side, cardId) {
  const card = CARDS[cardId];
  if (card.target === 'enemy_car') {
    return state[otherSide(side)].cars.filter((c) => !c.protected).map((c) => c.id);
  }
  if (card.target === 'own_car') {
    if (cardId === 'reinforce') return state[side].cars.filter((c) => !c.protected).map((c) => c.id);
    if (cardId === 'refresh') return state[side].cars.filter(isSpent).map((c) => c.id);
    if (cardId === 'overcharge') {
      // Sniper Car doesn't scale - that's the trade-off for ignoring armor.
      return state[side].cars.filter((c) => c.type !== 'claw' && c.type !== 'sniper').map((c) => c.id);
    }
    return state[side].cars.map((c) => c.id);
  }
  return [];
}

const SIDES = ['host', 'client'];

// Round resolution is split into three stages so the UI can animate each one
// separately: setup (sabotage/overcharge/reinforce/refresh + new cars
// coupling on, including a Wrecking Car firing the instant it couples)
// resolves first, then healing, then damage. Each stage mutates `state` in
// place and returns its own log lines; run identically on both peers.

export function resolveSetup(state, plays) {
  const log = [];
  const wrecks = []; // { attackerSide, attackerCarId, targetSide, targetCarId, targetCarSnapshot, targetIndex }

  for (const s of SIDES) for (const car of state[s].cars) car.disabledThisRound = false;
  for (const s of SIDES) if (plays[s].card === null) log.push(`${s} passes`);

  // sabotage / overcharge / reinforce / refresh - claw is handled below,
  // alongside the other cars that couple onto the train.
  for (const s of SIDES) {
    const play = plays[s];
    const opp = otherSide(s);
    if (play.card === 'sabotage') {
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
        car.overcharged = true;
        log.push(`${s} overcharges their ${car.type}`);
      }
    } else if (play.card === 'reinforce') {
      const car = findCar(state[s].cars, play.target);
      if (car) {
        car.protected = true;
        log.push(`${s} reinforces their ${car.type}`);
      }
    } else if (play.card === 'refresh') {
      const car = findCar(state[s].cars, play.target);
      if (car && isSpent(car)) {
        if (car.type === 'armor') {
          car.blockCharges = 1;
          log.push(`${s} refreshes their armor car`);
        } else if (car.type === 'claw') {
          // Reviving a Wrecking Car re-aims and fires it immediately, same
          // as when it was first placed - it goes right back to spent.
          const enemyCar = findCar(state[opp].cars, play.refreshTarget);
          if (enemyCar && !enemyCar.protected) {
            const targetIndex = state[opp].cars.indexOf(enemyCar);
            removeCar(state[opp].cars, enemyCar.id);
            log.push(`${s} refreshes their wrecking car, which destroys ${opp}'s ${enemyCar.type}`);
            wrecks.push({
              attackerSide: s,
              attackerCarId: car.id,
              targetSide: opp,
              targetCarId: enemyCar.id,
              targetCarSnapshot: { ...enemyCar },
              targetIndex,
            });
          } else {
            log.push(`${s} refreshes their wrecking car`);
          }
          car.fired = true;
        }
      }
    }
  }

  // new cars couple on (confirms whatever the UI already previewed) - at
  // whatever position in the train the player chose, defaulting to the
  // engine end (append) if they didn't specify one.
  for (const s of SIDES) {
    const play = plays[s];
    let car = null;
    if (play.card === 'armor') {
      car = { id: ++state.carCounter, type: 'armor', blockCharges: 1, protected: false, disabledThisRound: false };
      log.push(`${s} couples an Armor Car`);
    } else if (play.card === 'wagon') {
      car = { id: ++state.carCounter, type: 'wagon', dmgPerRound: 1, protected: false, disabledThisRound: false };
      log.push(`${s} couples an Artillery Wagon`);
    } else if (play.card === 'sniper') {
      car = { id: ++state.carCounter, type: 'sniper', dmgPerRound: 1, protected: false, disabledThisRound: false };
      log.push(`${s} couples a Sniper Car`);
    } else if (play.card === 'repair') {
      car = { id: ++state.carCounter, type: 'repair', healPerRound: 1, protected: false, disabledThisRound: false };
      log.push(`${s} couples a Repair Car`);
    } else if (play.card === 'claw') {
      car = { id: ++state.carCounter, type: 'claw', fired: false, protected: false, disabledThisRound: false };
      log.push(`${s} couples a Wrecking Car`);
    }
    if (car) insertCar(state[s].cars, car, play.insertIndex);

    // A Wrecking Car fires the instant it couples on, at whatever it was aimed at.
    if (play.card === 'claw' && car) {
      const opp = otherSide(s);
      const target = findCar(state[opp].cars, play.target);
      if (target && !target.protected) {
        const targetIndex = state[opp].cars.indexOf(target);
        removeCar(state[opp].cars, target.id);
        log.push(`${s}'s wrecking car destroys ${opp}'s ${target.type}`);
        wrecks.push({
          attackerSide: s,
          attackerCarId: car.id,
          targetSide: opp,
          targetCarId: target.id,
          targetCarSnapshot: { ...target },
          targetIndex,
        });
      }
      car.fired = true;
    }
  }

  return { log, wrecks };
}

// Which player's train triggers first alternates every round, so neither
// side has a standing advantage in the trigger phase.
function triggerOrder(state) {
  return state.round % 2 === 1 ? ['host', 'client'] : ['client', 'host'];
}

// Cars trigger in position order along the train, engine end first - new
// cars couple on next to the engine, so this is newest-first, working back
// toward the rear.
function inTriggerOrder(cars) {
  return cars.slice().reverse();
}

// Every coupled, non-disabled Repair Car heals its healPerRound, one car at
// a time in position order; whole trains go in the round's trigger order.
// Returns { log, triggered } - triggered is the car ids that fired, for the
// UI to pulse.
export function resolveHeal(state, plays) {
  const log = [];
  const triggered = [];
  for (const s of triggerOrder(state)) {
    for (const car of inTriggerOrder(state[s].cars)) {
      if (car.type !== 'repair' || car.disabledThisRound || car.healPerRound <= 0) continue;
      const before = state[s].hp;
      state[s].hp = Math.min(MAX_HP, state[s].hp + car.healPerRound);
      const healed = state[s].hp - before;
      if (healed > 0) {
        log.push(`${s}'s repair car heals ${healed} HP`);
        triggered.push(car.id);
      }
    }
  }
  return { log, triggered };
}

// A single hit against a target: an available armor car absorbs it (one
// charge, falls off once spent), otherwise it lands as real damage. Records
// a structured event (kind, source car, whether it was blocked and by what,
// and the target's hp immediately after) so the UI can replay the sequence
// hit by hit - e.g. animating a wagon's projectile and only revealing the
// damage once it "lands" - rather than just seeing the end result.
function applyHit(state, targetSide, amount, log, sourceLabel, events, kind, attackerSide, attackerCarId, ignoresArmor = false) {
  if (amount <= 0) return;

  const armorCar = ignoresArmor
    ? null
    : state[targetSide].cars.find((c) => c.type === 'armor' && c.blockCharges > 0 && !c.disabledThisRound);
  let blocked = false;
  let blockedByCarId = null;

  if (armorCar) {
    armorCar.blockCharges--;
    blocked = true;
    blockedByCarId = armorCar.id;
    log.push(`${targetSide}'s armor car blocks ${sourceLabel}`);
    // Spent, not destroyed - it stays coupled, just inert until an
    // Overcharge (or another Armor Car) gives it something to block with.
  } else {
    state[targetSide].hp -= amount;
    log.push(`${targetSide} takes ${amount} damage from ${sourceLabel}`);
  }

  events.push({
    kind,
    attackerSide,
    attackerCarId: attackerCarId ?? null,
    targetSide,
    amount,
    blocked,
    blockedByCarId,
    hpAfter: state[targetSide].hp,
  });
}

// Whole trains fire in the round's trigger order; within a train, coupled
// wagons go in position order. Each hit checks the target's armor
// individually, in that same sequence - overrides the old
// blocks-the-biggest-hit priority logic. Returns { log, events } - events is
// the ordered hit-by-hit trace described in applyHit, above.
export function resolveDamage(state, plays) {
  const log = [];
  const events = [];

  for (const attacker of triggerOrder(state)) {
    const target = otherSide(attacker);

    for (const car of inTriggerOrder(state[attacker].cars)) {
      if (car.type === 'wagon' && !car.disabledThisRound) {
        applyHit(state, target, car.dmgPerRound, log, `${attacker}'s artillery wagon`, events, 'wagon', attacker, car.id);
      } else if (car.type === 'sniper' && !car.disabledThisRound) {
        applyHit(state, target, car.dmgPerRound, log, `${attacker}'s sniper car`, events, 'sniper', attacker, car.id, true);
      }
    }
  }

  // Sudden death: escalating chip damage once round 9+ is reached
  if (state.round >= SUDDEN_DEATH_START_ROUND) {
    const chip = state.round - (SUDDEN_DEATH_START_ROUND - 1);
    for (const s of triggerOrder(state)) applyHit(state, s, chip, log, 'sudden death', events, 'suddendeath', null, null);
  }

  state.round += 1;
  return { log, events };
}

// Convenience: run all three stages back to back, for tests/simulations that
// don't care about the animated staging the UI does between them.
export function resolveRound(state, plays) {
  const setup = resolveSetup(state, plays);
  const heal = resolveHeal(state, plays);
  const damage = resolveDamage(state, plays);
  state.log = [...setup.log, ...heal.log, ...damage.log];
  return state;
}

export function checkWinner(state) {
  const hostDead = state.host.hp <= 0;
  const clientDead = state.client.hp <= 0;
  if (!hostDead && !clientDead) return null;
  if (hostDead && clientDead) return 'draw';
  return hostDead ? 'client' : 'host';
}
