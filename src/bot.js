// Simple heuristic bot: score each card in hand, play the best one.
// No lookahead - matches the "reasonable skill" bar from the design doc,
// nothing more.

import { CARDS, validTargets } from './game.js';

function carValue(car) {
  if (!car) return 0;
  if (car.type === 'wagon') return car.dmgPerRound * 3;
  if (car.type === 'armor') return car.blockCharges * 2;
  if (car.type === 'repair') return car.healPerRound * 2.5;
  return 0;
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

function scorePlay(state, side, cardId) {
  const opp = side === 'host' ? 'client' : 'host';
  const needsTarget = !!CARDS[cardId].target;
  const targets = needsTarget ? validTargets(state, side, cardId) : [];
  if (needsTarget && targets.length === 0) return { score: -Infinity, target: null };

  switch (cardId) {
    case 'track_break':
      return { score: 3, target: null };
    case 'wagon':
      return { score: 5, target: null };
    case 'repair': {
      const missing = 10 - state[side].hp;
      return { score: 1 + missing * 0.6, target: null };
    }
    case 'armor': {
      const incoming = state[opp].cars.filter((c) => c.type === 'wagon').reduce((a, c) => a + c.dmgPerRound, 0);
      return { score: 2 + incoming * 1.5, target: null };
    }
    case 'claw': {
      const target = bestTarget(state[opp].cars, targets);
      return { score: carValue(state[opp].cars.find((c) => c.id === target)), target };
    }
    case 'sabotage': {
      const target = bestTarget(state[opp].cars, targets);
      return { score: carValue(state[opp].cars.find((c) => c.id === target)) * 0.5, target };
    }
    case 'overcharge': {
      const target = bestTarget(state[side].cars, targets);
      return { score: 3, target };
    }
    case 'reinforce': {
      const target = bestTarget(state[side].cars, targets);
      return { score: 2, target };
    }
    default:
      return { score: -Infinity, target: null };
  }
}

export function chooseBotPlay(state, side, hand) {
  let best = null;
  let bestScore = -Infinity;
  for (const cardId of hand) {
    const { score, target } = scorePlay(state, side, cardId);
    if (score > bestScore) {
      bestScore = score;
      best = { card: cardId, target };
    }
  }
  return best || { card: hand[0], target: null };
}
