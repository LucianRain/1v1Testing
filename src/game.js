// Pure game logic for Reroute. No DOM, no networking - deterministic so both
// peers can run the exact same simulation from the same inputs and stay in sync.

export const ENGINE_MAX_HP = 3;
export const SUDDEN_DEATH_START_ROUND = 9;

// Wagon, Sniper, Armor, and Repair can each be upgraded in place - the UI
// lets a player drag one of these onto an existing car of the same type to
// upgrade it, or drop it anywhere else in the train to couple a separate
// duplicate instead. There's no dedicated Upgrade card anymore - this list
// is what resolveSetup checks a play's target against, and what the UI
// offers the drag-onto-self interaction for. Wrecking Car, Medic, and
// Saboteur are deliberately left out: Wrecker has nothing to scale, and
// Medic/Saboteur's one attempt per round is capped on purpose - letting
// either stack would mean one card permanently snowballing every turn it's
// re-played, which is worse than just letting extra copies couple as
// separate, individually-killable cars instead.
export const UPGRADABLE_TYPES = ['wagon', 'sniper', 'armor', 'repair'];

export const CARDS = {
  wagon: { name: 'Gunner', target: null, persistent: true, weapon: true, maxHp: 1, desc: '1 HP. 1 dmg/round.' },
  sniper: { name: 'Sniper', target: null, persistent: true, weapon: true, maxHp: 1, desc: '1 HP. 1 dmg/round. Hits the Wrecker first.' },
  claw: { name: 'Wrecker', target: 'enemy_car', persistent: true, maxHp: 1, desc: '1 HP. Destroys an enemy car.' },
  sabotage: { name: 'Sabotage', target: 'enemy_car', persistent: false, desc: 'Knocks an enemy car down a level for a round.' },
  armor: { name: 'Shield', target: null, persistent: true, maxHp: 2, desc: '2 HP. Shields a random car each round.' },
  repair: { name: 'Repair', target: null, persistent: true, maxHp: 1, desc: '1 HP. Heals 1 HP/round.' },
  medic: { name: 'Medic', target: null, persistent: true, maxHp: 2, desc: '2 HP. Revives a junked car each round.' },
  saboteur: { name: 'Saboteur', target: null, persistent: true, maxHp: 1, desc: '1 HP. Sabotages a random enemy car each round.' },
};

const CARD_IDS = Object.keys(CARDS);
// The Wrecking Car, Sniper Car, Sabotage, Medic, and Saboteur are pulled
// from the draw pool for now (not deleted from CARDS - their mechanics and
// rendering stay intact in case they come back). The Shield card (reinforce)
// and Refresh are gone for good, not just undrawable - Armor's own passive
// shield and Medic's own passive revive both make their one-shot
// equivalents redundant, so there's no reason to keep either standalone
// version around.
const DRAWABLE_CARD_IDS = CARD_IDS.filter(
  (id) => id !== 'claw' && id !== 'sniper' && id !== 'sabotage' && id !== 'medic' && id !== 'saboteur'
);

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
  return { rng, pile: shuffle(DRAWABLE_CARD_IDS, rng) };
}

export function draw(deck) {
  if (deck.pile.length === 0) deck.pile = shuffle(DRAWABLE_CARD_IDS, deck.rng);
  return deck.pile.pop();
}

// Passing: shuffle the current hand back into the deck, then draw a fresh one.
export function redrawHand(deck, hand, handSize = 2) {
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

// Keeps a second Medic out of hand while a living one is already coupled on
// the train - it would just sit there with nothing useful to do (its own
// passive already revives any junked friendly car, medic included - see
// medicPool). Only checks for a LIVING medic: once that one's junked, a
// fresh Medic is fair game again, and its own passive can revive the junked
// one in turn - see test-medic.mjs. Draws that don't help go back to the
// bottom of the pile rather than being lost.
export function ensureNoDuplicateMedic(state, side, deck, hand) {
  if (!state[side].cars.some((c) => c.type === 'medic' && c.hp > 0)) return hand;
  const idx = hand.indexOf('medic');
  if (idx === -1) return hand;

  const rejected = [];
  let found = null;
  for (let i = 0; i < 20 && found === null; i++) {
    const candidate = draw(deck);
    if (candidate !== 'medic') found = candidate;
    else rejected.push(candidate);
  }
  deck.pile = rejected.concat(deck.pile);
  if (found === null) return hand;

  const newHand = hand.slice();
  newHand[idx] = found;
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
    host: { engine: { hp: ENGINE_MAX_HP, maxHp: ENGINE_MAX_HP, shieldedThisRound: false }, cars: [] },
    client: { engine: { hp: ENGINE_MAX_HP, maxHp: ENGINE_MAX_HP, shieldedThisRound: false }, cars: [] },
    log: [],
  };
}

// A side's total remaining HP vs. its total possible HP right now (engine +
// every coupled car, junked or not - a junked car still counts toward the
// max, which is what makes it worth reviving with Medic or an upgrade).
// The train's total capacity grows as more cars couple on, and shrinks
// permanently only when a car is actually removed (a Wrecking Car kill),
// not merely junked.
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

// Moves an already-coupled car to a new position in its own train - a free
// action a player can do on their own turn to change trigger order, not
// tied to playing a card. Purely a reordering of state[side].cars: no RNG,
// no hidden information, so both peers can apply the exact same call (by
// car id) and stay in lockstep without needing to run it through
// resolveSetup/resolveTrigger. No-ops if the car isn't found.
export function reorderCar(state, side, carId, insertIndex) {
  const cars = state[side].cars;
  const fromIndex = cars.findIndex((c) => c.id === carId);
  if (fromIndex === -1) return;
  const [car] = cars.splice(fromIndex, 1);
  insertCar(cars, car, insertIndex);
}

// A car that's used up whatever made it useful but is still coupled: a
// Wrecking Car that's already fired. Distinct from being junked (0 HP) - a
// spent car can still be perfectly healthy, it's just done its job.
export function isSpent(car) {
  if (car.type === 'claw') return car.fired;
  return false;
}

// A car that's been shot to 0 HP: it no longer does anything (no damage, no
// healing, no blocking) - it can only come back via Medic's passive revive
// or a duplicate upgrade play targeting it directly.
export function isJunk(car) {
  return car.hp <= 0;
}

export function validTargets(state, side, cardId) {
  const card = CARDS[cardId];
  if (card.target === 'enemy_car') {
    let targets = state[otherSide(side)].cars.filter((c) => c.hp > 0);
    // A Wrecking Car can't snipe a car the instant it couples on - it needs
    // to survive at least one full round first.
    if (cardId === 'claw') targets = targets.filter((c) => !c.justCoupled);
    return targets.map((c) => c.id);
  }
  // No card targets its own train anymore (Refresh and the Shield card
  // both did, once) - everything else is either untargeted (couples on and
  // acts passively) or targets an enemy car above.
  return [];
}

const SIDES = ['host', 'client'];

// Round resolution is split into two stages so the UI can animate each one
// separately: setup (sabotage + new cars coupling on or merging into an
// existing upgrade, including a Wrecking Car firing the instant it couples)
// resolves first, then the trigger phase (every car's own recurring effect).
// Each stage mutates `state` in place and returns its own log lines; run
// identically on both peers.

export function resolveSetup(state, plays) {
  const log = [];
  const wrecks = []; // { attackerSide, attackerCarId, targetSide, targetCarId, targetCarSnapshot, targetIndex }

  // Last round's passive Armor shields (shieldedThisRound) are cleared here,
  // right before this round's Armor Cars roll fresh ones, rather than at
  // the end of last round's trigger phase - that way the flag stays visible
  // on screen for the whole round it actually applied to, instead of
  // disappearing before anything ever renders.
  for (const s of SIDES) {
    state[s].engine.shieldedThisRound = false;
    for (const car of state[s].cars) {
      car.disabledThisRound = 0;
      car.justCoupled = false;
      car.shieldedThisRound = false;
    }
  }
  for (const s of SIDES) if (plays[s].card === null) log.push(`${s} passes`);

  // Sabotage - claw, and Upgrade's drag-onto-self effect for the other
  // coupling cards, are handled below, alongside the other cars that
  // couple onto the train.
  for (const s of SIDES) {
    const play = plays[s];
    const opp = otherSide(s);
    if (play.card === 'sabotage') {
      const car = findCar(state[opp].cars, play.target);
      if (car && car.hp > 0) {
        // Knocks one upgrade level off its output for the round (see
        // resolveTrigger) rather than fully disabling it outright - stacks
        // with the Saboteur car's own passive if both land on the same car.
        car.disabledThisRound = (car.disabledThisRound || 0) + 1;
        log.push(`${s} sabotages ${opp}'s ${car.type}`);
      }
    }
  }

  // new cars couple on (confirms whatever the UI already previewed) - at
  // whatever position in the train the player chose, defaulting to the
  // engine end (append) if they didn't specify one. For an upgradable type
  // (see UPGRADABLE_TYPES), the UI lets the player drag the card directly
  // onto an existing car of that same type instead of dropping it at a
  // position - play.target then carries that car's id, and this merges into
  // it rather than coupling a whole separate car. Every upgrade level adds
  // +1 max HP (and heals that same point immediately), on top of its own
  // type's stat bump. If the target was alive, this stacks another upgrade
  // level. If it was junked, this both revives it (full HP, at the new
  // bumped max) AND resets it to a fresh level-1 upgrade - it doesn't
  // continue whatever upgrade stack it had before dying, it starts over as
  // if newly built and immediately upgraded once. Wrecking Car is exempt:
  // it has nothing to scale, so it's never offered this interaction at all.
  for (const s of SIDES) {
    const play = plays[s];
    let car = null;

    const existing = UPGRADABLE_TYPES.includes(play.card) && play.target != null
      ? findCar(state[s].cars, play.target)
      : null;

    if (existing && existing.hp <= 0) {
      existing.maxHp += 1;
      existing.hp = existing.maxHp;
      existing.upgradeLevel = 1;
      if (existing.type === 'wagon') existing.dmgPerRound = 2;
      if (existing.type === 'sniper') existing.dmgPerRound = 2;
      if (existing.type === 'armor') existing.shieldRolls = 2;
      if (existing.type === 'repair') existing.healPerRound = 2;
      existing.overcharged = true;
      log.push(`${s}'s new ${play.card} revives their junked one as a level-1 upgrade`);
    } else if (existing) {
      existing.maxHp += 1;
      existing.hp += 1;
      if (existing.type === 'wagon') existing.dmgPerRound += 1;
      if (existing.type === 'sniper') existing.dmgPerRound += 1;
      if (existing.type === 'armor') existing.shieldRolls += 1;
      if (existing.type === 'repair') existing.healPerRound += 1;
      existing.overcharged = true;
      existing.upgradeLevel = (existing.upgradeLevel || 0) + 1;
      log.push(`${s}'s new ${play.card} merges into their existing one, upgrading it`);
    } else if (play.card === 'armor') {
      car = { id: ++state.carCounter, type: 'armor', shieldRolls: 1, disabledThisRound: 0, justCoupled: true, shieldedThisRound: false, upgradeLevel: 0, hp: CARDS.armor.maxHp, maxHp: CARDS.armor.maxHp };
      log.push(`${s} couples an Armor Car`);
    } else if (play.card === 'wagon') {
      car = { id: ++state.carCounter, type: 'wagon', dmgPerRound: 1, disabledThisRound: 0, justCoupled: true, shieldedThisRound: false, upgradeLevel: 0, hp: CARDS.wagon.maxHp, maxHp: CARDS.wagon.maxHp };
      log.push(`${s} couples an Artillery Wagon`);
    } else if (play.card === 'sniper') {
      car = { id: ++state.carCounter, type: 'sniper', dmgPerRound: 1, disabledThisRound: 0, justCoupled: true, shieldedThisRound: false, upgradeLevel: 0, hp: CARDS.sniper.maxHp, maxHp: CARDS.sniper.maxHp };
      log.push(`${s} couples a Sniper Car`);
    } else if (play.card === 'repair') {
      car = { id: ++state.carCounter, type: 'repair', healPerRound: 1, disabledThisRound: 0, justCoupled: true, shieldedThisRound: false, upgradeLevel: 0, hp: CARDS.repair.maxHp, maxHp: CARDS.repair.maxHp };
      log.push(`${s} couples a Repair Car`);
    } else if (play.card === 'medic') {
      car = { id: ++state.carCounter, type: 'medic', disabledThisRound: 0, justCoupled: true, shieldedThisRound: false, upgradeLevel: 0, hp: CARDS.medic.maxHp, maxHp: CARDS.medic.maxHp };
      log.push(`${s} couples a Medic`);
    } else if (play.card === 'saboteur') {
      car = { id: ++state.carCounter, type: 'saboteur', disabledThisRound: 0, justCoupled: true, shieldedThisRound: false, upgradeLevel: 0, hp: CARDS.saboteur.maxHp, maxHp: CARDS.saboteur.maxHp };
      log.push(`${s} couples a Saboteur`);
    } else if (play.card === 'claw') {
      car = { id: ++state.carCounter, type: 'claw', fired: false, disabledThisRound: 0, justCoupled: true, shieldedThisRound: false, upgradeLevel: 0, hp: CARDS.claw.maxHp, maxHp: CARDS.claw.maxHp };
      log.push(`${s} couples a Wrecking Car`);
    }
    if (car) insertCar(state[s].cars, car, play.insertIndex);

    // A Wrecking Car fires the instant it couples on, at whatever it was aimed at.
    if (play.card === 'claw' && car) {
      const opp = otherSide(s);
      const target = findCar(state[opp].cars, play.target);
      if (target && target.hp > 0) {
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

// Which player's whole train triggers first alternates every round, so
// neither side has a standing advantage.
function sidePriority(state) {
  return state.round % 2 === 1 ? ['host', 'client'] : ['client', 'host'];
}

// Cars trigger in position order along the train, engine end first - new
// cars couple on next to the engine, so this is newest-first, working back
// toward the rear.
function inTriggerOrder(cars) {
  return cars.slice().reverse();
}

// The trigger phase's firing order: whichever side has priority this round
// (see sidePriority) fires its ENTIRE train, in position order (engine end
// first), before the other side's train starts at all. Within one side,
// order is purely by position - e.g. engine -> artillery -> heal fires
// artillery, then heal, regardless of which is "newer".
function fullTriggerOrder(state) {
  const ranked = [];
  for (const side of sidePriority(state)) {
    for (const car of inTriggerOrder(state[side].cars)) ranked.push({ side, car });
  }
  return ranked;
}

// A living, coupled car is a candidate for a random hit - a junked car (0
// HP) is never picked, so no shot is ever wasted on something already
// destroyed. The Engine is the last thing standing: it's only a valid hit
// target once every coupled car on that side has been killed. Shielded cars
// (protected, or Armor's shieldedThisRound) are NOT excluded here - they can
// still be picked, but applyHit deals no damage when one is (see below).
// That's deliberate: it gives Shield a chance to fully waste an incoming
// shot instead of just guaranteeing the damage always lands on someone else.
function hittablePool(state, side) {
  const livingCars = state[side].cars.filter((c) => c.hp > 0).map((car) => ({ kind: 'car', car }));
  if (livingCars.length > 0) return livingCars;
  return state[side].engine.hp > 0 ? [{ kind: 'engine' }] : [];
}

// Sniper Cars hunt the Wrecking Car first - if one is still alive on the
// target side, that's the only candidate; otherwise falls back to the usual
// living-cars-then-engine pool.
function hittablePoolPreferClaw(state, side) {
  const livingClaws = state[side].cars.filter((c) => c.type === 'claw' && c.hp > 0).map((car) => ({ kind: 'car', car }));
  if (livingClaws.length > 0) return livingClaws;
  return hittablePool(state, side);
}

// Armor's protective pick isn't restricted by the "engine only once
// everything else is dead" rule hittablePool enforces for incoming attacks -
// it can shield the engine directly if that's what the roll lands on.
function shieldablePool(state, side) {
  const pool = state[side].cars.filter((c) => c.hp > 0).map((car) => ({ kind: 'car', car }));
  if (state[side].engine.hp > 0) pool.push({ kind: 'engine' });
  return pool;
}

function healablePool(state, side) {
  const pool = [];
  const engine = state[side].engine;
  if (engine.hp > 0 && engine.hp < engine.maxHp) pool.push({ kind: 'engine' });
  for (const car of state[side].cars) if (car.hp > 0 && car.hp < car.maxHp) pool.push({ kind: 'car', car });
  return pool;
}

// Medic's revival pool - junked (0 HP) cars only, never a merely-damaged
// one (that's Repair's job) and never the engine (by the time it's at 0 HP
// the match is already over, per checkWinner).
function medicPool(state, side) {
  return state[side].cars.filter((c) => c.hp <= 0).map((car) => ({ kind: 'car', car }));
}

// Saboteur's target pool for its own passive - unlike a hit, this never
// falls back to the engine once every car is dead. It only ever picks a
// living enemy car, or nothing at all.
function saboteurPool(state, side) {
  return state[side].cars.filter((c) => c.hp > 0).map((car) => ({ kind: 'car', car }));
}

function pickRandom(pool, rng) {
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

// A single hit against a target side: it lands on whichever car (or the
// engine) the shared battle RNG randomly picks among what's still standing,
// Shielded or not - an Armor Car no longer absorbs hits directly, it only
// grants its passive random Shield (see the 'armor' case in resolveTrigger,
// below). If what it lands on happens to be Shielded (the Shield card's
// protected, or an Armor Car's passive shieldedThisRound pick), the shot is
// wasted - no damage to anyone - but the shield only absorbs ONE hit: it
// breaks the instant it does, so a later shot that lands on the same target
// later this same round deals damage normally. Records a structured event
// so the UI can replay the sequence hit by hit - e.g. firing a projectile
// at the actual car it hit, and only revealing the result once it "lands".
function applyHit(state, targetSide, amount, log, sourceLabel, events, kind, attackerSide, attackerCarId, poolBuilder = hittablePool) {
  if (amount <= 0) return;

  let hitKind = null; // 'engine' | 'car' | null (nothing left standing)
  let hitCarId = null;
  let junked = false;
  let shielded = false; // hit landed on a Shielded target - no damage dealt
  let targetHpAfter = null; // the specific engine/car's own HP after this hit

  const picked = pickRandom(poolBuilder(state, targetSide), state.battleRng);
  if (picked && picked.kind === 'engine') {
    hitKind = 'engine';
    shielded = state[targetSide].engine.shieldedThisRound;
    if (shielded) {
      targetHpAfter = state[targetSide].engine.hp;
      // The shield absorbs this one hit, then breaks - a later hit this same
      // round lands normally, it doesn't just keep no-selling every shot.
      state[targetSide].engine.shieldedThisRound = false;
      log.push(`${targetSide}'s shielded engine takes no damage from ${sourceLabel} and the shield breaks`);
    } else {
      state[targetSide].engine.hp = Math.max(0, state[targetSide].engine.hp - amount);
      targetHpAfter = state[targetSide].engine.hp;
      log.push(`${targetSide}'s engine takes ${amount} damage from ${sourceLabel}`);
    }
  } else if (picked) {
    const car = picked.car;
    hitKind = 'car';
    hitCarId = car.id;
    shielded = car.shieldedThisRound;
    if (shielded) {
      targetHpAfter = car.hp;
      // Same one-hit-and-broken rule as the engine's shield, above.
      car.shieldedThisRound = false;
      log.push(`${targetSide}'s shielded ${car.type} takes no damage from ${sourceLabel} and the shield breaks`);
    } else {
      car.hp = Math.max(0, car.hp - amount);
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
    hitKind,
    hitCarId,
    junked,
    shielded,
    targetHpAfter,
    hpAfter: computeHp(state, targetSide).hp,
  });
}

// Every coupled, non-disabled, non-junked car triggers its own effect (heal
// or damage) in fullTriggerOrder - purely by train position, never grouped
// by side. Returns { log, events } - events is the ordered hit-by-hit trace
// described in applyHit, above, plus heal entries (kind: 'heal') shaped so
// the UI can replay them the same way.
export function resolveTrigger(state, plays) {
  const log = [];
  const events = [];
  // One entry per car in fullTriggerOrder (junked cars included) - the UI
  // uses this to pulse every car in turn order, even one that's junked or
  // does nothing this round, so the whole trigger phase reads as a
  // sequence instead of only the cars that happened to land a visible hit.
  // eventStart/eventEnd slice into `events` for whatever this specific
  // car's own turn produced (empty range for a junked or no-op turn).
  // Sudden death's events, appended after this loop, aren't tied to any
  // one car's turn and so aren't covered by any range here.
  const turns = [];

  for (const { side, car } of fullTriggerOrder(state)) {
    const target = otherSide(side);
    if (car.hp <= 0) {
      turns.push({ side, carId: car.id, junk: true, eventStart: events.length, eventEnd: events.length });
      continue;
    }
    const eventStart = events.length;
    // Sabotage no longer fully skips a car's turn - it knocks one upgrade
    // level off its output for the round instead (see the manual Sabotage
    // card and the Saboteur car's own passive, below), floored at 0. An
    // unupgraded (level 0) car sabotaged once has nothing left to reduce,
    // so it still ends up doing nothing - "completely disabled" is just
    // what a level-0 car sabotaged looks like, not a separate rule.
    const sabotage = car.disabledThisRound || 0;
    if (car.type === 'repair') {
      const healPerRound = Math.max(0, car.healPerRound - sabotage);
      if (healPerRound > 0) {
        const picked = pickRandom(healablePool(state, side), state.battleRng);
        if (picked) {
          const healTarget = picked.kind === 'engine' ? state[side].engine : picked.car;
          const before = healTarget.hp;
          healTarget.hp = Math.min(healTarget.maxHp, healTarget.hp + healPerRound);
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
              hitKind: picked.kind,
              hitCarId: picked.kind === 'car' ? picked.car.id : null,
              targetHpAfter: healTarget.hp,
              junked: false,
              hpAfter: computeHp(state, side).hp,
            });
          }
        }
      }
    } else if (car.type === 'wagon') {
      // Each point of dmgPerRound (base 1, +1 per Upgrade, -1 per sabotage)
      // is its own separately-aimed 1-dmg shot, not one lump hit - an
      // upgraded wagon can spread damage across several enemy cars in a
      // single round.
      const dmgPerRound = Math.max(0, car.dmgPerRound - sabotage);
      for (let i = 0; i < dmgPerRound; i++) {
        applyHit(state, target, 1, log, `${side}'s artillery wagon`, events, 'wagon', side, car.id);
      }
    } else if (car.type === 'sniper') {
      // Unlike the wagon, a sniper always fires its whole dmgPerRound as
      // one shot - and it always goes for the Wrecking Car first.
      const dmgPerRound = Math.max(0, car.dmgPerRound - sabotage);
      applyHit(state, target, dmgPerRound, log, `${side}'s sniper car`, events, 'sniper', side, car.id, hittablePoolPreferClaw);
    } else if (car.type === 'armor') {
      // Armor's passive shield is granted right when its own turn in the
      // trigger order comes up, not upfront before the round starts - a car
      // that fires earlier in the order (closer to the engine) is exposed to
      // hits before this armor car has had a chance to shield anyone. It no
      // longer blocks a hit outright - each of its shieldRolls (base 1, +1
      // per Upgrade, -1 per sabotage) independently picks a random friendly
      // car or the engine to shield for the rest of this trigger phase.
      const shieldRolls = Math.max(0, car.shieldRolls - sabotage);
      for (let i = 0; i < shieldRolls; i++) {
        const picked = pickRandom(shieldablePool(state, side), state.battleRng);
        if (picked) {
          if (picked.kind === 'engine') state[side].engine.shieldedThisRound = true;
          else picked.car.shieldedThisRound = true;
        }
      }
    } else if (car.type === 'medic') {
      // Not upgradable (see UPGRADABLE_TYPES) - always exactly one revival
      // attempt per round, no matter how many Medics end up coupled. It has
      // nothing to reduce a level off, so being sabotaged just skips it outright.
      const picked = sabotage > 0 ? null : pickRandom(medicPool(state, side), state.battleRng);
      if (picked) {
        const revived = picked.car;
        revived.hp = Math.max(1, Math.ceil(revived.maxHp / 2));
        log.push(`${side}'s medic revives their junked ${revived.type}`);
        events.push({
          kind: 'revive',
          attackerSide: side,
          attackerCarId: car.id,
          targetSide: side,
          amount: revived.hp,
          hitKind: 'car',
          hitCarId: revived.id,
          junked: false,
          targetHpAfter: revived.hp,
          hpAfter: computeHp(state, side).hp,
        });
      }
    } else if (car.type === 'saboteur') {
      // Not upgradable (see UPGRADABLE_TYPES) - always exactly one sabotage
      // attempt per round, same reasoning as Medic. A sabotaged Saboteur
      // doesn't get to sabotage anyone this round either. Never targets the
      // engine - only ever an enemy car.
      const picked = sabotage > 0 ? null : pickRandom(saboteurPool(state, target), state.battleRng);
      if (picked) {
        const victim = picked.car;
        victim.disabledThisRound = (victim.disabledThisRound || 0) + 1;
        log.push(`${side}'s saboteur sabotages ${target}'s ${victim.type}`);
      }
    }
    turns.push({ side, carId: car.id, junk: false, eventStart, eventEnd: events.length });
  }

  // Sudden death: escalating chip damage once round 9+ is reached, after
  // every car's own trigger - not tied to any one car's turn, so it's not
  // covered by any range in `turns` above.
  if (state.round >= SUDDEN_DEATH_START_ROUND) {
    const chip = state.round - (SUDDEN_DEATH_START_ROUND - 1);
    for (const s of sidePriority(state)) applyHit(state, s, chip, log, 'sudden death', events, 'suddendeath', null, null);
  }

  // This round's passive Armor shields are left in place here so they're
  // still visible on screen through the rest of this round's rendering -
  // resolveSetup clears them at the top of the NEXT round, right before
  // that round's Armor Cars roll fresh ones.
  state.round += 1;
  return { log, events, turns };
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
