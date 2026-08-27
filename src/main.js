import { PeerNetwork, formatRoomCode, toPeerId } from './network.js';
import { CARDS, MAX_HP, createDeck, draw, redrawHand, ensurePlayable, deriveSeed, createMatchState, resolveSetup, resolveHeal, resolveDamage, validTargets, checkWinner } from './game.js';
import { chooseBotPlay } from './bot.js';

const menuOverlay = document.getElementById('menu-overlay');
const gameScreen = document.getElementById('game-screen');

const btnBot = document.getElementById('btn-bot');
const btnHost = document.getElementById('btn-host');
const btnJoin = document.getElementById('btn-join');
const hostCodeWrap = document.getElementById('host-code-wrap');
const hostCodeEl = document.getElementById('host-code');
const hostStatusEl = document.getElementById('host-status');
const joinCodeInput = document.getElementById('join-code-input');
const joinStatusEl = document.getElementById('join-status');

const roundInfoEl = document.getElementById('round-info');
const myHpEl = document.getElementById('my-hp');
const myHpFillEl = document.getElementById('my-hp-fill');
const myTrainEl = document.getElementById('my-train');
const myTrackEl = document.getElementById('my-track');
const oppHpEl = document.getElementById('opp-hp');
const oppHpFillEl = document.getElementById('opp-hp-fill');
const oppTrainEl = document.getElementById('opp-train');
const oppTrackEl = document.getElementById('opp-track');
const handEl = document.getElementById('hand');
const btnPass = document.getElementById('btn-pass');
const targetAreaEl = document.getElementById('target-area');
const targetCancelBtn = document.getElementById('target-cancel');
const waitStatusEl = document.getElementById('wait-status');
const cardRevealEl = document.getElementById('card-reveal');
const revealTitleEl = document.getElementById('reveal-title');
const revealDescEl = document.getElementById('reveal-desc');
const roundBannerEl = document.getElementById('round-banner');
const gameOverEl = document.getElementById('game-over');
const gameOverTextEl = document.getElementById('game-over-text');
const btnRestart = document.getElementById('btn-restart');

const net = new PeerNetwork();

const BOT_DELAY_MS = 700; // how long the bot "thinks" before committing
const REVEAL_MS = 1600; // how long the opponent's played card stays up
const STAGE_MS = 550; // gap between setup / heal / damage in the resolution animation
const BANNER_MS = 1300; // how long the "Round N" banner stays up
const PROJECTILE_MS = 950; // wagon projectile travel time
const EVENT_PAUSE_MS = 300; // non-projectile damage events (sudden death)
const EVENT_GAP_MS = 150; // breather between damage events once one has landed

let myRole = null; // 'host' | 'client'
let oppRole = null;
let matchState = null;
let myDeck = null;
let myHand = [];
let myPlay = null;
let oppPlay = null;
let gameOver = false;
let resolving = false;
let vsBot = false;
let botDeck = null;
let botHand = [];
let pendingPlay = null; // { cardId, handIdx } while picking a target on the field
let myPendingCar = null; // optimistic preview of a wagon/armor I just committed
let myPendingInsertIndex = null; // where in my train that preview goes
let oppPendingCar = null; // same, for the opponent's just-revealed play
let oppPendingInsertIndex = null;
let dragState = null; // in-progress drag of a train-car hand card
let targetDragState = null; // in-progress arc-targeting drag (Sabotage, or aiming a placed Wrecking Car)
let awaitingAim = null; // { cardId, handIdx, insertIndex } once a Wrecking Car is placed but not yet aimed
let myLastTrainWidth = null;
let oppLastTrainWidth = null;
let inTriggerPhase = false;
let pulsingIds = new Set(); // car ids to pulse on the next render, then cleared
let revealTimeout = null;
let bannerTimeout = null;

function pendingCarFor(cardId) {
  if (cardId === 'wagon') return { type: 'wagon', dmgPerRound: 1, pending: true };
  if (cardId === 'armor') return { type: 'armor', blockCharges: 1, pending: true };
  if (cardId === 'repair') return { type: 'repair', healPerRound: 1, pending: true };
  if (cardId === 'claw') return { type: 'claw', pending: true };
  return null;
}

function insertAt(cars, car, index) {
  const i = index == null ? cars.length : Math.max(0, Math.min(index, cars.length));
  cars.splice(i, 0, car);
}

btnBot.addEventListener('click', () => {
  vsBot = true;
  myRole = 'host';
  oppRole = 'client';
  menuOverlay.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  startMatch(Math.floor(Math.random() * 2 ** 31));
});

net.addEventListener('connected', () => {
  menuOverlay.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  myRole = net.role;
  oppRole = myRole === 'host' ? 'client' : 'host';

  if (myRole === 'host') {
    const seed = Math.floor(Math.random() * 2 ** 31);
    net.send({ t: 'init', seed });
    startMatch(seed);
  }
});

net.addEventListener('data', (e) => {
  const msg = e.detail;
  if (msg.t === 'init') {
    startMatch(msg.seed);
  } else if (msg.t === 'play') {
    handleOppPlayKnown(msg.card, msg.target, msg.insertIndex);
  }
});

net.addEventListener('close', () => {
  waitStatusEl.textContent = 'Opponent disconnected.';
  waitStatusEl.classList.remove('hidden');
});

function startMatch(seed) {
  matchState = createMatchState();
  myDeck = createDeck(deriveSeed(seed, myRole));
  myHand = ensurePlayable(matchState, myRole, myDeck, [draw(myDeck), draw(myDeck), draw(myDeck)]);
  if (vsBot) {
    botDeck = createDeck(deriveSeed(seed, oppRole));
    botHand = ensurePlayable(matchState, oppRole, botDeck, [draw(botDeck), draw(botDeck), draw(botDeck)]);
  }
  myPlay = null;
  oppPlay = null;
  myPendingCar = null;
  myPendingInsertIndex = null;
  oppPendingCar = null;
  oppPendingInsertIndex = null;
  awaitingAim = null;
  myLastTrainWidth = null;
  oppLastTrainWidth = null;
  inTriggerPhase = false;
  pulsingIds = new Set();
  resolving = false;
  gameOver = false;
  render();
}

function render() {
  roundInfoEl.textContent = inTriggerPhase ? 'Trigger Phase' : `Round ${matchState.round}`;
  renderHp(myHpEl, myHpFillEl, matchState[myRole].hp);
  renderHp(oppHpEl, oppHpFillEl, matchState[oppRole].hp);
  renderTrains();
  renderHand();
}

function renderHp(labelEl, fillEl, hp) {
  labelEl.textContent = hp;
  const pct = Math.max(0, Math.min(1, hp / MAX_HP)) * 100;
  fillEl.style.width = `${pct}%`;
  fillEl.classList.toggle('low', hp <= MAX_HP * 0.3);
}

// hpOverride, when given ({ my, opp }), positions the trains using those HP
// values instead of matchState's live ones - used mid-damage-animation, where
// matchState already holds the fully-resolved future state but the train on
// the rails shouldn't move until the hit that caused it has actually landed.
function renderTrains(hpOverride) {
  let myValidIds = null;
  let oppValidIds = null;

  if (pendingPlay) {
    const card = CARDS[pendingPlay.cardId];
    const ids = new Set(validTargets(matchState, myRole, pendingPlay.cardId));
    if (card.target === 'enemy_car') oppValidIds = ids;
    else myValidIds = ids;
  }

  const myCars = matchState[myRole].cars.slice();
  if (myPendingCar) insertAt(myCars, myPendingCar, myPendingInsertIndex);
  const oppCars = matchState[oppRole].cars.slice();
  if (oppPendingCar) insertAt(oppCars, oppPendingCar, oppPendingInsertIndex);

  renderTrain(myTrainEl, myCars, myValidIds);
  renderTrain(oppTrainEl, oppCars, oppValidIds);

  const myHp = hpOverride ? hpOverride.my : matchState[myRole].hp;
  const oppHp = hpOverride ? hpOverride.opp : matchState[oppRole].hp;
  myLastTrainWidth = positionTrain(myTrainEl, myTrackEl, myHp, myLastTrainWidth);
  oppLastTrainWidth = positionTrain(oppTrainEl, oppTrackEl, oppHp, oppLastTrainWidth);
}

// Full HP: engine (rightmost) touches the track's right edge.
// Near dead: the last car (leftmost) touches the track's left edge.
//
// A car coupling/uncoupling changes the train's width, which also changes
// where "left" needs to be to keep it anchored - but that's a size
// correction, not a move, so it should snap instantly rather than sliding
// through the animated `left` transition (which otherwise briefly overshoots
// past the track edge before settling). Only animate when HP itself is what
// changed the position.
function positionTrain(trainEl, trackEl, hp, lastWidth) {
  const frac = Math.max(0, Math.min(1, hp / MAX_HP));
  const trainWidth = trainEl.offsetWidth;
  const room = trackEl.offsetWidth - trainWidth;
  const left = Math.max(0, room) * frac;

  if (lastWidth !== null && lastWidth !== trainWidth) {
    const prevTransition = trainEl.style.transition;
    trainEl.style.transition = 'none';
    trainEl.style.left = `${left}px`;
    void trainEl.offsetHeight; // flush so the no-transition position applies before restoring
    trainEl.style.transition = prevTransition;
  } else {
    trainEl.style.left = `${left}px`;
  }

  return trainWidth;
}

function renderTrain(el, cars, validIds) {
  el.innerHTML = '';

  // Cars trail behind the engine, which leads on the right - the train faces right.
  cars.forEach((car) => {
    const box = document.createElement('div');
    const pulse = car.id != null && pulsingIds.has(car.id);
    const spent = (car.type === 'armor' && car.blockCharges <= 0) || (car.type === 'claw' && car.fired);
    box.className = `car-box ${car.type}${car.pending ? ' pending' : ''}${pulse ? ' pulse' : ''}${spent ? ' spent' : ''}`;
    if (car.id != null) box.dataset.carId = car.id;
    let stat;
    if (car.type === 'wagon') stat = `${car.dmgPerRound}/rd`;
    else if (car.type === 'armor') stat = spent ? 'spent' : `${car.blockCharges}x block`;
    else if (car.type === 'claw') stat = car.needsAim ? 'aim me' : spent ? 'spent' : 'armed';
    else stat = `+${car.healPerRound}/rd`;
    box.innerHTML = `<strong>${CARDS[car.type].name}</strong><span>${stat}${car.protected ? ' · shielded' : ''}</span>`;
    if (validIds && car.id != null && validIds.has(car.id)) {
      box.classList.add('targetable');
      box.addEventListener('click', () => chooseTarget(car.id));
    }
    if (car.pending && car.needsAim) {
      box.classList.add('needs-aim');
      box.addEventListener('pointerdown', (e) => startClawAim(e, box));
    }
    el.appendChild(box);
  });

  const engine = document.createElement('div');
  engine.className = 'car-box engine';
  engine.textContent = 'ENGINE';
  el.appendChild(engine);
}

function renderHand() {
  handEl.innerHTML = '';
  const locked = !!myPlay || !!pendingPlay || gameOver;
  btnPass.disabled = locked;
  waitStatusEl.classList.toggle('hidden', !myPlay || gameOver);
  if (oppPlay) waitStatusEl.textContent = 'Resolving...';
  else waitStatusEl.textContent = vsBot ? 'Bot is thinking...' : 'Waiting for opponent...';

  myHand.forEach((cardId, idx) => {
    const card = CARDS[cardId];
    const btn = document.createElement('button');
    btn.className = 'card-btn';
    const needsTarget = !!card.target;
    const targets = needsTarget ? validTargets(matchState, myRole, cardId) : [];
    const disabled = locked || (needsTarget && targets.length === 0);
    btn.disabled = disabled;
    btn.innerHTML = `<strong>${card.name}</strong><span>${card.desc}</span>`;
    if (card.persistent) {
      // Train cars (wagon/armor/repair/claw): drag onto your train to
      // choose where in the order it couples on, instead of a plain click.
      // A Wrecking Car (claw) then needs a second drag - see onCardDragEnd.
      btn.classList.add('draggable');
      btn.addEventListener('pointerdown', (e) => startCardDrag(e, cardId, idx, btn));
    } else if (cardId === 'sabotage') {
      // Drag out an arcing targeting reticle at an enemy car instead of a
      // two-step click.
      btn.classList.add('draggable');
      btn.addEventListener('pointerdown', (e) => startSabotageDrag(e, cardId, idx, btn));
    } else {
      btn.addEventListener('click', () => {
        if (needsTarget) {
          beginTargeting(cardId, idx);
        } else {
          commitPlay(cardId, idx, null);
        }
      });
    }
    handEl.appendChild(btn);
  });
}

// Dragging a train-car hand card: a ghost follows the pointer, and an
// insertion-line indicator snaps to the nearest gap between your existing
// cars (or before the first / right before the engine) as you drag over
// your own train. Dropping off the train cancels the play entirely.
function startCardDrag(e, cardId, handIdx, sourceBtn) {
  if (sourceBtn.disabled || dragState) return;
  e.preventDefault();
  const card = CARDS[cardId];

  const ghost = document.createElement('div');
  ghost.className = 'card-ghost';
  ghost.innerHTML = `<strong>${card.name}</strong><span>${card.desc}</span>`;
  document.body.appendChild(ghost);

  const indicator = document.createElement('div');
  indicator.className = 'insert-indicator';
  document.body.appendChild(indicator);

  dragState = { cardId, handIdx, ghost, indicator, insertIndex: null, overTrain: false, sourceBtn };
  moveGhost(e.clientX, e.clientY);
  updateDropTarget(e.clientX, e.clientY);

  sourceBtn.setPointerCapture(e.pointerId);
  sourceBtn.addEventListener('pointermove', onCardDragMove);
  sourceBtn.addEventListener('pointerup', onCardDragEnd);
  sourceBtn.addEventListener('pointercancel', onCardDragEnd);
}

function moveGhost(x, y) {
  dragState.ghost.style.left = `${x}px`;
  dragState.ghost.style.top = `${y}px`;
}

function onCardDragMove(e) {
  if (!dragState) return;
  moveGhost(e.clientX, e.clientY);
  updateDropTarget(e.clientX, e.clientY);
}

function updateDropTarget(x, y) {
  const trackRect = myTrackEl.getBoundingClientRect();
  const overTrain = x >= trackRect.left && x <= trackRect.right && y >= trackRect.top && y <= trackRect.bottom;
  dragState.overTrain = overTrain;
  dragState.indicator.classList.toggle('visible', overTrain);
  if (!overTrain) return;

  const carBoxes = Array.from(myTrainEl.querySelectorAll('.car-box:not(.engine)'));
  let index = carBoxes.length;
  let indicatorX = null;
  for (let i = 0; i < carBoxes.length; i++) {
    const rect = carBoxes[i].getBoundingClientRect();
    if (x < rect.left + rect.width / 2) {
      index = i;
      indicatorX = rect.left;
      break;
    }
  }
  if (indicatorX === null) {
    const engine = myTrainEl.querySelector('.car-box.engine');
    indicatorX = engine ? engine.getBoundingClientRect().left : trackRect.right;
  }
  dragState.insertIndex = index;
  dragState.indicator.style.left = `${indicatorX}px`;
  dragState.indicator.style.top = `${trackRect.top}px`;
  dragState.indicator.style.height = `${trackRect.height}px`;
}

function onCardDragEnd(e) {
  if (!dragState) return;
  const { cardId, handIdx, overTrain, insertIndex, ghost, indicator, sourceBtn } = dragState;
  ghost.remove();
  indicator.remove();
  sourceBtn.removeEventListener('pointermove', onCardDragMove);
  sourceBtn.removeEventListener('pointerup', onCardDragEnd);
  sourceBtn.removeEventListener('pointercancel', onCardDragEnd);
  dragState = null;
  if (!overTrain) return; // dropped off the train, cancel - the card just stays in hand

  if (cardId === 'claw') {
    // Placed, not yet committed - still needs aiming at an enemy car before
    // this play is real. Shows as a "needs-aim" preview; the second drag
    // (from that car, via startClawAim) finishes the play.
    awaitingAim = { cardId, handIdx, insertIndex };
    myPendingCar = { type: 'claw', pending: true, needsAim: true };
    myPendingInsertIndex = insertIndex;
    pendingPlay = { cardId, handIdx }; // reuses the enemy-car highlight machinery
    renderTrains();
    renderHand();
  } else {
    commitPlay(cardId, handIdx, null, insertIndex);
  }
}

// Shared arc-targeting reticle: drag from a source element (a hand card for
// Sabotage, or a just-placed Wrecking Car on the train for aiming it) and an
// arcing line + reticle follow the pointer. Releasing over a highlighted
// (.targetable) car picks it; releasing anywhere else calls back with null.
function startArcTargeting(e, sourceEl, onComplete) {
  if (dragState || targetDragState) return;
  e.preventDefault();
  const rect = sourceEl.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'targeting-arc');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  svg.appendChild(path);
  document.body.appendChild(svg);

  const reticle = document.createElement('div');
  reticle.className = 'targeting-reticle';
  document.body.appendChild(reticle);

  targetDragState = { originX, originY, svg, reticle, sourceEl, onComplete };
  updateArc(e.clientX, e.clientY);

  sourceEl.setPointerCapture(e.pointerId);
  sourceEl.addEventListener('pointermove', onTargetDragMove);
  sourceEl.addEventListener('pointerup', onTargetDragEnd);
  sourceEl.addEventListener('pointercancel', onTargetDragEnd);
}

function onTargetDragMove(e) {
  if (!targetDragState) return;
  updateArc(e.clientX, e.clientY);
}

function updateArc(x, y) {
  const { originX, originY, svg, reticle } = targetDragState;
  const dx = x - originX;
  const dy = y - originY;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const bow = Math.min(len * 0.35, 90);
  const mx = (originX + x) / 2 + px * bow;
  const my = (originY + y) / 2 + py * bow;
  svg.querySelector('path').setAttribute('d', `M ${originX} ${originY} Q ${mx} ${my} ${x} ${y}`);
  reticle.style.left = `${x}px`;
  reticle.style.top = `${y}px`;
}

function onTargetDragEnd(e) {
  if (!targetDragState) return;
  const { svg, reticle, sourceEl, onComplete } = targetDragState;
  svg.remove();
  reticle.remove();
  sourceEl.removeEventListener('pointermove', onTargetDragMove);
  sourceEl.removeEventListener('pointerup', onTargetDragEnd);
  sourceEl.removeEventListener('pointercancel', onTargetDragEnd);
  targetDragState = null;

  const dropEl = document.elementFromPoint(e.clientX, e.clientY);
  const targetBox = dropEl ? dropEl.closest('.car-box.targetable') : null;
  const targetId = targetBox && targetBox.dataset.carId != null ? Number(targetBox.dataset.carId) : null;
  onComplete(targetId);
}

function startSabotageDrag(e, cardId, handIdx, sourceBtn) {
  if (sourceBtn.disabled || dragState || targetDragState) return;
  pendingPlay = { cardId, handIdx };
  renderTrains(); // safe: doesn't touch the hand DOM the pointer is captured on
  startArcTargeting(e, sourceBtn, (targetId) => {
    pendingPlay = null;
    if (targetId != null) {
      commitPlay(cardId, handIdx, targetId);
    } else {
      renderTrains();
      renderHand();
    }
  });
}

// Aiming a Wrecking Car that's already been placed (see onCardDragEnd). A
// miss just leaves it waiting - the player can try again.
function startClawAim(e, boxEl) {
  if (!awaitingAim || dragState || targetDragState) return;
  const { cardId, handIdx, insertIndex } = awaitingAim;
  startArcTargeting(e, boxEl, (targetId) => {
    if (targetId != null) {
      awaitingAim = null;
      pendingPlay = null;
      commitPlay(cardId, handIdx, targetId, insertIndex);
    } else {
      renderTrains();
      renderHand();
    }
  });
}

function beginTargeting(cardId, handIdx) {
  pendingPlay = { cardId, handIdx };
  targetAreaEl.classList.remove('hidden');
  renderTrains();
  renderHand();
}

function chooseTarget(targetId) {
  if (!pendingPlay) return;
  const { cardId, handIdx } = pendingPlay;
  pendingPlay = null;
  commitPlay(cardId, handIdx, targetId);
}

targetCancelBtn.addEventListener('click', () => {
  pendingPlay = null;
  targetAreaEl.classList.add('hidden');
  renderTrains();
  renderHand();
});

btnPass.addEventListener('click', () => {
  myHand = redrawHand(myDeck, myHand);
  myPlay = { card: null, target: null };
  targetAreaEl.classList.add('hidden');
  renderHand();
  if (vsBot) {
    setTimeout(playBotTurn, BOT_DELAY_MS);
  } else {
    net.send({ t: 'play', card: null, target: null });
    runResolution();
  }
});

function playBotTurn() {
  const botChoice = chooseBotPlay(matchState, oppRole, botHand);
  botHand.splice(botHand.indexOf(botChoice.card), 1);
  handleOppPlayKnown(botChoice.card, botChoice.target, null); // bot always appends at the engine end
}

function commitPlay(cardId, handIdx, target, insertIndex) {
  myHand.splice(handIdx, 1);
  insertIndex = insertIndex ?? null;
  myPlay = { card: cardId, target, insertIndex };
  myPendingCar = pendingCarFor(cardId);
  myPendingInsertIndex = insertIndex;
  targetAreaEl.classList.add('hidden');
  renderTrains();
  renderHand();
  if (vsBot) {
    setTimeout(playBotTurn, BOT_DELAY_MS);
  } else {
    net.send({ t: 'play', card: cardId, target, insertIndex });
    runResolution();
  }
}

// Opponent's play is known (bot decided, or a networked message arrived):
// show their new car instantly and reveal what they played, same as our own
// turn, before the actual resolution animation runs.
function handleOppPlayKnown(cardId, target, insertIndex) {
  insertIndex = insertIndex ?? null;
  oppPlay = { card: cardId, target, insertIndex };
  oppPendingCar = pendingCarFor(cardId);
  oppPendingInsertIndex = insertIndex;
  render();
  if (cardId) {
    showCardReveal(cardId);
    setTimeout(runResolution, REVEAL_MS);
  } else {
    runResolution();
  }
}

function showCardReveal(cardId) {
  const card = CARDS[cardId];
  revealTitleEl.textContent = card.name;
  revealDescEl.textContent = card.desc;
  cardRevealEl.classList.add('visible');
  clearTimeout(revealTimeout);
  revealTimeout = setTimeout(() => cardRevealEl.classList.remove('visible'), REVEAL_MS);
}

// Runs once both plays are known: setup, then healing, then damage, each
// applied and rendered in turn with a short pause so the player can follow
// what happened, then a "Round N" banner before the next round unlocks.
function runResolution() {
  if (!myPlay || !oppPlay || gameOver || resolving) return;
  resolving = true;

  const plays = { [myRole]: myPlay, [oppRole]: oppPlay };

  resolveSetup(matchState, plays);
  myPendingCar = null;
  myPendingInsertIndex = null;
  oppPendingCar = null;
  oppPendingInsertIndex = null;
  render();

  setTimeout(() => {
    inTriggerPhase = true;
    const heal = resolveHeal(matchState, plays);
    pulsingIds = new Set(heal.triggered);
    render();
    pulsingIds = new Set(); // consumed - don't let a later unrelated render replay it

    setTimeout(async () => {
      const preDamageHp = { host: matchState.host.hp, client: matchState.client.hp };
      const damage = resolveDamage(matchState, plays); // fully resolved now; revealed to the player hit by hit below
      await playDamageEvents(damage.events, preDamageHp);
      inTriggerPhase = false;
      render();
      finishRound(plays);
    }, STAGE_MS);
  }, STAGE_MS);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function carBoxEl(side, carId) {
  const container = side === myRole ? myTrainEl : oppTrainEl;
  return container.querySelector(`[data-car-id="${carId}"]`);
}

function engineBoxEl(side) {
  const container = side === myRole ? myTrainEl : oppTrainEl;
  return container.querySelector('.car-box.engine');
}

// Animates a small dot from `fromEl` to `toEl`, resolving once it "lands".
// Skips the visual slide (but keeps the same timing) under reduced motion.
function fireProjectile(fromEl, toEl) {
  return new Promise((resolve) => {
    if (!fromEl || !toEl) {
      resolve();
      return;
    }
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();

    const dot = document.createElement('div');
    dot.className = 'projectile';
    dot.style.left = `${fromRect.left + fromRect.width / 2}px`;
    dot.style.top = `${fromRect.top + fromRect.height / 2}px`;
    document.body.appendChild(dot);

    if (reduceMotion) {
      dot.style.left = `${toRect.left + toRect.width / 2}px`;
      dot.style.top = `${toRect.top + toRect.height / 2}px`;
    } else {
      dot.style.transition = `left ${PROJECTILE_MS}ms linear, top ${PROJECTILE_MS}ms linear`;
      void dot.offsetWidth; // flush the starting position before animating
      dot.style.left = `${toRect.left + toRect.width / 2}px`;
      dot.style.top = `${toRect.top + toRect.height / 2}px`;
    }

    setTimeout(() => {
      dot.remove();
      resolve();
    }, PROJECTILE_MS);
  });
}

// Replays a resolved damage stage hit by hit: a wagon's shot fires a
// projectile and only reveals its damage once it lands; other sources just
// get a short beat. Next car doesn't trigger until the current one lands.
// `displayedHp` starts at each side's HP from before this damage stage
// (matchState itself is already fully resolved to the *end* of the stage by
// the time this runs) and is only advanced to an event's hpAfter once that
// event has actually landed - so neither the HP bar nor the train's position
// on the rails moves early.
async function playDamageEvents(events, displayedHp) {
  const hpOverride = () => ({ my: displayedHp[myRole], opp: displayedHp[oppRole] });

  for (const event of events) {
    if (event.kind === 'wagon') {
      pulsingIds = new Set([event.attackerCarId]);
      renderTrains(hpOverride());
      pulsingIds = new Set();
      await fireProjectile(carBoxEl(event.attackerSide, event.attackerCarId), engineBoxEl(event.targetSide));
    } else {
      await wait(EVENT_PAUSE_MS);
    }

    // Landed - now it's safe to reveal the result.
    displayedHp[event.targetSide] = event.hpAfter;
    if (event.blocked) pulsingIds = new Set([event.blockedByCarId]);
    const hpEl = event.targetSide === myRole ? myHpEl : oppHpEl;
    const fillEl = event.targetSide === myRole ? myHpFillEl : oppHpFillEl;
    renderHp(hpEl, fillEl, event.hpAfter);
    renderTrains(hpOverride());
    pulsingIds = new Set();

    await wait(EVENT_GAP_MS);
  }
}

function finishRound(plays) {
  if (plays[myRole].card !== null) myHand.push(draw(myDeck));
  if (vsBot && plays[oppRole].card !== null) botHand.push(draw(botDeck));
  myHand = ensurePlayable(matchState, myRole, myDeck, myHand);
  if (vsBot) botHand = ensurePlayable(matchState, oppRole, botDeck, botHand);

  const winner = checkWinner(matchState);
  if (winner) {
    gameOver = true;
    resolving = false;
    myPlay = null;
    oppPlay = null;
    render();
    showGameOver(winner);
    return;
  }

  showRoundBanner(matchState.round);
  setTimeout(() => {
    resolving = false;
    myPlay = null;
    oppPlay = null;
    render();
  }, BANNER_MS);
}

function showRoundBanner(roundNum) {
  roundBannerEl.textContent = `Round ${roundNum}`;
  roundBannerEl.classList.add('visible');
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => roundBannerEl.classList.remove('visible'), BANNER_MS - 250);
}

function showGameOver(winner) {
  gameOverEl.classList.remove('hidden');
  if (winner === 'draw') {
    gameOverTextEl.textContent = 'Both trains destroyed. Draw.';
  } else if (winner === myRole) {
    gameOverTextEl.textContent = 'You win.';
  } else {
    gameOverTextEl.textContent = 'You lose.';
  }
}

btnRestart.addEventListener('click', () => location.reload());

btnHost.addEventListener('click', async () => {
  btnHost.disabled = true;
  hostStatusEl.textContent = 'Creating room...';
  try {
    const id = await net.host();
    hostCodeWrap.classList.remove('hidden');
    hostCodeEl.textContent = formatRoomCode(id);
    hostStatusEl.textContent = 'Waiting for opponent to join...';
    hostCodeEl.addEventListener('click', () => {
      navigator.clipboard?.writeText(formatRoomCode(id)).catch(() => {});
    });
  } catch (err) {
    hostStatusEl.textContent = `Error: ${err.message || err}`;
    btnHost.disabled = false;
  }
});

btnJoin.addEventListener('click', async () => {
  const code = joinCodeInput.value.trim();
  if (!code) {
    joinStatusEl.textContent = 'Enter a room code first.';
    return;
  }
  btnJoin.disabled = true;
  joinStatusEl.textContent = 'Connecting...';
  try {
    await net.join(toPeerId(code));
  } catch (err) {
    joinStatusEl.textContent = `Error: ${err.message || err}`;
    btnJoin.disabled = false;
  }
});
