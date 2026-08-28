// Simple heuristic bot: score each card in hand, play the best one.
// No lookahead - matches the "reasonable skill" bar from the design doc,
// nothing more.

import { CARDS, validTargets, computeHp } from './game.js';

function carValue(car) {
  if (!car) return 0;
  let base = 0;
  if (car.type === 'wagon') base = car.dmgPerRound * 3;
  else if (car.type === 'sniper') base = car.dmgPerRound * 3.5; // unblockable - a bit more worth removing than a wagon
  else if (car.type === 'armor') base = car.shieldRolls * 2;
  else if (car.type === 'repair') base = car.healPerRound * 2.5;
  else if (car.type === 'medic') base = 2.5; // flat - it doesn't scale, there's no shieldRolls-style stat to read
  // A car close to dying on its own is worth less to spend a card removing.
  return base * (car.hp / car.maxHp);
}

function bestTarget(cars, ids) {
  let best = null;
  let bestVal = -Infinity;
  for (const id of ids) {
    const car = cars.find((c) => c.id === id);
    const v = carValue(car);
    if (v > bestVal) {
      bestVal = v;
      best = id;
    }
  }
  return best;
}

// Wagon/Sniper/Armor/Repair upgrade an existing car of the same type
// (alive or junked) if one's already coupled, instead of adding a separate
// one - matches how a player would drag the card directly onto it.
function existingOfType(state, side, type) {
  const car = state[side].cars.find((c) => c.type === type);
  return car ? car.id : null;
}

function scorePlay(state, side, cardId) {
  const opp = side === 'host' ? 'client' : 'host';
  const needsTarget = !!CARDS[cardId].target;
  const targets = needsTarget ? validTargets(state, side, cardId) : [];
  if (needsTarget && targets.length === 0) return { score: -Infinity, target: null };

  switch (cardId) {
    case 'wagon':
      return { score: 5, target: existingOfType(state, side, 'wagon') };
    case 'sniper':
      return { score: 4, target: existingOfType(state, side, 'sniper') };
    case 'repair': {
      const { hp, maxHp } = computeHp(state, side);
      const missing = maxHp - hp;
      return { score: 1 + missing * 0.6, target: existingOfType(state, side, 'repair') };
    }
    case 'armor': {
      const incoming = state[opp].cars.filter((c) => c.type === 'wagon').reduce((a, c) => a + c.dmgPerRound, 0);
      return { score: 2 + incoming * 1.5, target: existingOfType(state, side, 'armor') };
    }
    case 'medic': {
      // Not upgradable - always couples a fresh one, never a target. Worth
      // much more with an actual junked car to bring back this round.
      const hasJunked = state[side].cars.some((c) => c.hp <= 0);
      return { score: hasJunked ? 5 : 1.5, target: null };
    }
    case 'claw': {
      const target = bestTarget(state[opp].cars, targets);
      return { score: carValue(state[opp].cars.find((c) => c.id === target)), target };
    }
    case 'sabotage': {
      const target = bestTarget(state[opp].cars, targets);
      return { score: carValue(state[opp].cars.find((c) => c.id === target)) * 0.5, target };
    }
    case 'refresh': {
      const incoming = state[opp].cars.filter((c) => c.type === 'wagon').reduce((a, c) => a + c.dmgPerRound, 0);
      return { score: 2 + incoming * 1.2, target: targets[0] };
    }
    default:
      return { score: -Infinity, target: null };
  }
}

export function chooseBotPlay(state, side, hand) {
  let best = null;
  let bestScore = -Infinity;
  for (const cardId of hand) {
    const { score, target, refreshTarget } = scorePlay(state, side, cardId);
    if (score > bestScore) {
      bestScore = score;
      best = { card: cardId, target, refreshTarget };
    }
  }
  return best || { card: hand[0], target: null };
}
