// Pure game logic for Reroute. No DOM, no networking - deterministic so both
// peers can run the exact same simulation from the same inputs and stay in sync.

export const ENGINE_MAX_HP = 6;
export const SUDDEN_DEATH_START_ROUND = 9;

export const CARDS = {
  wagon: { name: 'Artillery Wagon', target: null, persistent: true, weapon: true, maxHp: 4, desc: 'Couples on: 4 HP, 1 dmg every round' },
  sniper: { name: 'Sniper Car', target: null, persistent: true, weapon: true, maxHp: 3, desc: 'Couples on: 3 HP, 1 dmg every round, ignores Armor Car' },
  claw: { name: 'Wrecking Car', target: 'enemy_car', persistent: true, maxHp: 2, desc: 'Couples on: 2 HP, then destroys one of their coupled cars' },
  sabotage: { name: 'Sabotage', target: 'enemy_car', persistent: false, desc: "Disable one of their coupled cars this round" },
  armor: { name: 'Armor Car', target: null, persistent: true, maxHp: 4, desc: 'Couples on: 4 HP, blocks your next hit(s)' },
  repair: { name: 'Repair Car', target: null, persistent: true, maxHp: 3, desc: 'Couples on: 3 HP, heals 1 HP every round' },
  overcharge: { name: 'Overcharge', target: 'own_car', persistent: false, desc: 'Upgrade one of your coupled cars' },
  reinforce: { name: 'Reinforced Coupling', target: 'own_car', persistent: false, desc: 'Protect one of your coupled cars' },
  refresh: { name: 'Refresh', target: 'own_car', persistent: false, desc: 'Heal a damaged car to full, or revive a destroyed one at half HP' },
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
// nothing to card-count. 'battle' derives a third, independent RNG stream
// used for in-round randomness (which car a hit/heal lands on) - both peers
// derive the same stream from the same shared seed and advance it in lockstep
// by running the identical sequence of resolveSetup/resolveTrigger calls.
const SEED_SALTS = { host: 0x9e3779b9, client: 0x85ebca6b, battle: 0xc2b2ae35 };
export function deriveSeed(masterSeed, role) {
  const salt = SEED_SALTS[role] ?? 0;
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

// battleSeed seeds the shared, in-round randomness (which car a hit/heal
// lands on) - both peers must create their match state with the same seed
// (derived off the shared match seed via deriveSeed(seed, 'battle')) so their
// simulations stay identical.
export function createMatchState(battleSeed = 0) {
  return {
    round: 1,
    carCounter: 0,
    battleRng: makeRng(battleSeed >>> 0),
    host: { engine: { hp: ENGINE_MAX_HP, maxHp: ENGINE_MAX_HP }, cars: [] },
    client: { engine: { hp: ENGINE_MAX_HP, maxHp: ENGINE_MAX_HP }, cars: [] },
    log: [],
  };
}

// A side's total remaining HP vs. its total possible HP right now (engine +
// every coupled car, junked or not - a junked car still counts toward the
// max, which is what makes it worth reviving with Refresh). The train's
// total capacity grows as more cars couple on, and shrinks permanently only
// when a car is actually removed (a Wrecking Car kill), not merely junked.
export function computeHp(state, side) {
  let hp = state[side].engine.hp;
  let maxHp = state[side].engine.maxHp;
  for (const car of state[side].cars) {
    hp += car.hp;
    maxHp += car.maxHp;
  }
  return { hp, maxHp };
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
// Distinct from being junked (0 HP) - a spent car can still be perfectly
// healthy, it's just done its job.
export function isSpent(car) {
  if (car.type === 'armor') return car.blockCharges <= 0;
  if (car.type === 'claw') return car.fired;
  return false;
}

// A car that's been shot to 0 HP: it no longer does anything (no damage, no
// healing, no blocking) and can't be targeted by any card except Refresh.
export function isJunk(car) {
  return car.hp <= 0;
}

export function validTargets(state, side, cardId) {
  const card = CARDS[cardId];
  if (card.target === 'enemy_car') {
    let targets = state[otherSide(side)].cars.filter((c) => !c.protected && c.hp > 0);
    // A Wrecking Car can't snipe a car the instant it couples on - it needs
    // to survive at least one full round first.
    if (cardId === 'claw') targets = targets.filter((c) => !c.justCoupled);
    return targets.map((c) => c.id);
  }
  if (card.target === 'own_car') {
    if (cardId === 'reinforce') return state[side].cars.filter((c) => !c.protected && c.hp > 0).map((c) => c.id);
    if (cardId === 'refresh') {
      // Anything not at full HP (damaged or junked), or a fully-healthy
      // Armor Car that's just out of charges.
      return state[side].cars
        .filter((c) => c.hp < c.maxHp || (c.type === 'armor' && c.blockCharges <= 0))
        .map((c) => c.id);
    }
    if (cardId === 'overcharge') {
      // Sniper Car doesn't scale - that's the trade-off for ignoring armor.
      return state[side].cars.filter((c) => c.type !== 'claw' && c.type !== 'sniper' && c.hp > 0).map((c) => c.id);
    }
    return state[side].cars.map((c) => c.id);
  }
  return [];
}

const SIDES = ['host', 'client'];

// Round resolution is split into two stages so the UI can animate each one
// separately: setup (sabotage/overcharge/reinforce/refresh + new cars
// coupling on, including a Wrecking Car firing the instant it couples)
// resolves first, then the trigger phase (every car's own recurring effect).
// Each stage mutates `state` in place and returns its own log lines; run
// identically on both peers.

export function resolveSetup(state, plays) {
  const log = [];
  const wrecks = []; // { attackerSide, attackerCarId, targetSide, targetCarId, targetCarSnapshot, targetIndex }

  for (const s of SIDES) for (const car of state[s].cars) { car.disabledThisRound = false; car.justCoupled = false; }
  for (const s of SIDES) if (plays[s].card === null) log.push(`${s} passes`);

  // sabotage / overcharge / reinforce / refresh - claw is handled below,
  // alongside the other cars that couple onto the train.
  for (const s of SIDES) {
    const play = plays[s];
    const opp = otherSide(s);
    if (play.card === 'sabotage') {
      const car = findCar(state[opp].cars, play.target);
      if (car && !car.protected && car.hp > 0) {
        car.disabledThisRound = true;
        log.push(`${s} sabotages ${opp}'s ${car.type}`);
      }
    } else if (play.card === 'overcharge') {
      const car = findCar(state[s].cars, play.target);
      if (car && car.hp > 0) {
        if (car.type === 'wagon') car.dmgPerRound += 1;
        if (car.type === 'armor') car.blockCharges += 1;
        if (car.type === 'repair') car.healPerRound += 1;
        car.overcharged = true;
        log.push(`${s} overcharges their ${car.type}`);
      }
    } else if (play.card === 'reinforce') {
      const car = findCar(state[s].cars, play.target);
      if (car && car.hp > 0) {
        car.protected = true;
        log.push(`${s} reinforces their ${car.type}`);
      }
    } else if (play.card === 'refresh') {
      const car = findCar(state[s].cars, play.target);
      if (car) {
        if (car.hp <= 0) {
          // Destroyed (junked): a partial revival - it doesn't undo whatever
          // already happened to it, a fired Wrecking Car stays fired/spent.
          car.hp = Math.max(1, Math.ceil(car.maxHp / 2));
          if (car.type === 'armor') car.blockCharges = 1;
          log.push(`${s} revives their junked ${car.type}`);
        } else if (car.hp < car.maxHp) {
          car.hp = car.maxHp;
          if (car.type === 'armor') car.blockCharges = 1;
          log.push(`${s} refreshes their ${car.type} to full health`);
        } else if (car.type === 'armor' && car.blockCharges <= 0) {
          car.blockCharges = 1;
          log.push(`${s} refreshes their armor car`);
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
      car = { id: ++state.carCounter, type: 'armor', blockCharges: 1, protected: false, disabledThisRound: false, justCoupled: true, hp: CARDS.armor.maxHp, maxHp: CARDS.armor.maxHp };
      log.push(`${s} couples an Armor Car`);
    } else if (play.card === 'wagon') {
      car = { id: ++state.carCounter, type: 'wagon', dmgPerRound: 1, protected: false, disabledThisRound: false, justCoupled: true, hp: CARDS.wagon.maxHp, maxHp: CARDS.wagon.maxHp };
      log.push(`${s} couples an Artillery Wagon`);
    } else if (play.card === 'sniper') {
      car = { id: ++state.carCounter, type: 'sniper', dmgPerRound: 1, protected: false, disabledThisRound: false, justCoupled: true, hp: CARDS.sniper.maxHp, maxHp: CARDS.sniper.maxHp };
      log.push(`${s} couples a Sniper Car`);
    } else if (play.card === 'repair') {
      car = { id: ++state.carCounter, type: 'repair', healPerRound: 1, protected: false, disabledThisRound: false, justCoupled: true, hp: CARDS.repair.maxHp, maxHp: CARDS.repair.maxHp };
      log.push(`${s} couples a Repair Car`);
    } else if (play.card === 'claw') {
      car = { id: ++state.carCounter, type: 'claw', fired: false, protected: false, disabledThisRound: false, justCoupled: true, hp: CARDS.claw.maxHp, maxHp: CARDS.claw.maxHp };
      log.push(`${s} couples a Wrecking Car`);
    }
    if (car) insertCar(state[s].cars, car, play.insertIndex);

    // A Wrecking Car fires the instant it couples on, at whatever it was aimed at.
    if (play.card === 'claw' && car) {
      const opp = otherSide(s);
      const target = findCar(state[opp].cars, play.target);
      if (target && !target.protected && target.hp > 0) {
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

// Every car (and the engine) still standing on a side is a candidate for a
// random hit or heal - a junked car (0 HP) is never picked, so no shot is
// ever wasted on something already destroyed.
function hittablePool(state, side) {
  const pool = [];
  if (state[side].engine.hp > 0) pool.push({ kind: 'engine' });
  for (const car of state[side].cars) if (car.hp > 0) pool.push({ kind: 'car', car });
  return pool;
}

function healablePool(state, side) {
  const pool = [];
  const engine = state[side].engine;
  if (engine.hp > 0 && engine.hp < engine.maxHp) pool.push({ kind: 'engine' });
  for (const car of state[side].cars) if (car.hp > 0 && car.hp < car.maxHp) pool.push({ kind: 'car', car });
  return pool;
}

function pickRandom(pool, rng) {
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

// A single hit against a target side: an available armor car absorbs it
// entirely (one charge, falls off once spent) - otherwise it lands on
// whichever car (or the engine) the shared battle RNG randomly picks among
// what's still standing. Records a structured event so the UI can replay the
// sequence hit by hit - e.g. firing a projectile at the actual car it hit,
// and only revealing the damage once it "lands".
function applyHit(state, targetSide, amount, log, sourceLabel, events, kind, attackerSide, attackerCarId, ignoresArmor = false) {
  if (amount <= 0) return;

  const armorCar = ignoresArmor
    ? null
    : state[targetSide].cars.find((c) => c.type === 'armor' && c.blockCharges > 0 && c.hp > 0 && !c.disabledThisRound);

  let blocked = false;
  let blockedByCarId = null;
  let hitKind = null; // 'engine' | 'car' | null (blocked, or nothing left standing)
  let hitCarId = null;
  let junked = false;
  let targetHpAfter = null; // the specific engine/car's own HP after this hit

  if (armorCar) {
    armorCar.blockCharges--;
    blocked = true;
    blockedByCarId = armorCar.id;
    log.push(`${targetSide}'s armor car blocks ${sourceLabel}`);
    // Spent, not destroyed - it stays coupled, just inert until an
    // Overcharge (or Refresh) gives it something to block with again.
  } else {
    const picked = pickRandom(hittablePool(state, targetSide), state.battleRng);
    if (picked && picked.kind === 'engine') {
      state[targetSide].engine.hp = Math.max(0, state[targetSide].engine.hp - amount);
      hitKind = 'engine';
      targetHpAfter = state[targetSide].engine.hp;
      log.push(`${targetSide}'s engine takes ${amount} damage from ${sourceLabel}`);
    } else if (picked) {
      const car = picked.car;
      car.hp = Math.max(0, car.hp - amount);
      hitKind = 'car';
      hitCarId = car.id;
      junked = car.hp <= 0;
      targetHpAfter = car.hp;
      log.push(`${targetSide}'s ${car.type} takes ${amount} damage from ${sourceLabel}${junked ? ' and is junked' : ''}`);
    }
  }

  events.push({
    kind,
    attackerSide,
    attackerCarId: attackerCarId ?? null,
    targetSide,
    amount,
    blocked,
    blockedByCarId,
    hitKind,
    hitCarId,
    junked,
    targetHpAfter,
    hpAfter: computeHp(state, targetSide).hp,
  });
}

// One whole train triggers completely - every coupled, non-disabled,
// non-junked car in position order, whichever effect it has (heal or
// damage) - before the other train starts, per the round's trigger order.
// Returns { log, events } - events is the ordered hit-by-hit trace described
// in applyHit, above, plus heal entries (kind: 'heal') shaped so the UI can
// replay them the same way.
export function resolveTrigger(state, plays) {
  const log = [];
  const events = [];

  for (const side of triggerOrder(state)) {
    const target = otherSide(side);

    for (const car of inTriggerOrder(state[side].cars)) {
      if (car.disabledThisRound || car.hp <= 0) continue;
      if (car.type === 'repair' && car.healPerRound > 0) {
        const picked = pickRandom(healablePool(state, side), state.battleRng);
        if (picked) {
          const healTarget = picked.kind === 'engine' ? state[side].engine : picked.car;
          const before = healTarget.hp;
          healTarget.hp = Math.min(healTarget.maxHp, healTarget.hp + car.healPerRound);
          const healed = healTarget.hp - before;
          if (healed > 0) {
            const label = picked.kind === 'engine' ? 'engine' : picked.car.type;
            log.push(`${side}'s repair car heals ${label} for ${healed} HP`);
            events.push({
              kind: 'heal',
              attackerSide: side,
              attackerCarId: car.id,
              targetSide: side,
              amount: healed,
              blocked: false,
              blockedByCarId: null,
              hitKind: picked.kind,
              hitCarId: picked.kind === 'car' ? picked.car.id : null,
              targetHpAfter: healTarget.hp,
              junked: false,
              hpAfter: computeHp(state, side).hp,
            });
          }
        }
      } else if (car.type === 'wagon') {
        applyHit(state, target, car.dmgPerRound, log, `${side}'s artillery wagon`, events, 'wagon', side, car.id);
      } else if (car.type === 'sniper') {
        applyHit(state, target, car.dmgPerRound, log, `${side}'s sniper car`, events, 'sniper', side, car.id, true);
      }
    }
  }

  // Sudden death: escalating chip damage once round 9+ is reached - after
  // every car's own trigger, still in the round's side-major order.
  if (state.round >= SUDDEN_DEATH_START_ROUND) {
    const chip = state.round - (SUDDEN_DEATH_START_ROUND - 1);
    for (const s of triggerOrder(state)) applyHit(state, s, chip, log, 'sudden death', events, 'suddendeath', null, null);
  }

  state.round += 1;
  return { log, events };
}

// Convenience: run both stages back to back, for tests/simulations that
// don't care about the animated staging the UI does between them.
export function resolveRound(state, plays) {
  const setup = resolveSetup(state, plays);
  const trigger = resolveTrigger(state, plays);
  state.log = [...setup.log, ...trigger.log];
  return state;
}

export function checkWinner(state) {
  const hostDead = computeHp(state, 'host').hp <= 0;
  const clientDead = computeHp(state, 'client').hp <= 0;
  if (!hostDead && !clientDead) return null;
  if (hostDead && clientDead) return 'draw';
  return hostDead ? 'client' : 'host';
}
