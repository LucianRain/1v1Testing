import { PeerNetwork, formatRoomCode, toPeerId } from './network.js';
import { CARDS, createDeck, draw, redrawHand, ensurePlayable, ensureWeapon, deriveSeed, createMatchState, computeHp, resolveSetup, resolveTrigger, validTargets, checkWinner } from './game.js';
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
const quickActionsEl = document.getElementById('quick-actions');
const btnResumeHost = document.getElementById('btn-resume-host');
const resumeHostCodeEl = document.getElementById('resume-host-code');
const btnQuickJoin = document.getElementById('btn-quick-join');
const quickJoinCodeEl = document.getElementById('quick-join-code');
const btnModeAuto = document.getElementById('btn-mode-auto');
const btnModeInvite = document.getElementById('btn-mode-invite');
const autoModePanel = document.getElementById('auto-mode-panel');
const inviteModePanel = document.getElementById('invite-mode-panel');
const btnAutoMatch = document.getElementById('btn-auto-match');
const btnAutoCancel = document.getElementById('btn-auto-cancel');
const autoStatusEl = document.getElementById('auto-status');

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
const hintTextEl = document.getElementById('hint-text');
const roundBannerEl = document.getElementById('round-banner');
const gameOverEl = document.getElementById('game-over');
const gameOverTextEl = document.getElementById('game-over-text');
const btnRestart = document.getElementById('btn-restart');

const net = new PeerNetwork();

const RESUME_ROOM_KEY = 'reroute-hosted-room'; // localStorage: a room I created but nobody had joined yet
const ROOM_CODE_RE = /^[A-Z]{4}$/; // a plain 4-letter word room code
// Keep in sync with game.js's own MERGEABLE_TYPES - playing one of these
// when a living one of the same type is already coupled upgrades it in
// place instead of coupling a new car (Wrecking Car is exempt).
const MERGEABLE_HAND_TYPES = ['wagon', 'sniper', 'armor', 'repair'];
const AUTO_LOBBY_ID = 'reroute-auto-lobby-v1'; // fixed, well-known id: autoMode pairs up whoever reaches it first
const AUTO_JOIN_TIMEOUT_MS = 4000; // fail fast when trying to join - a real "nobody's here" is near-instant anyway
const AUTO_RETRY_DELAY_MS = 3000; // how long to wait before retrying when the lobby's already full

let matchMode = 'autoMode'; // 'autoMode' | 'inviteMode' - which panel is showing on the main menu
let autoMatchGeneration = 0; // bumped to invalidate an in-flight autoMode search (cancel, or switching modes)

const BOT_DELAY_MS = 700; // how long the bot "thinks" before committing
const STAGE_MS = 550; // gap between setup and the trigger phase in the resolution animation
const BANNER_MS = 1300; // how long the "Round N" banner stays up
const PROJECTILE_MS = 950; // wagon projectile travel time
const SNIPER_PROJECTILE_MS = 550; // sniper shot: smaller and faster than a wagon shell
const EVENT_PAUSE_MS = 300; // non-projectile damage events (sudden death)
const EVENT_GAP_MS = 150; // breather between damage events once one has landed
const WRECK_LINE_MS = 380; // Wrecking Car's grapple line reaching the target
const WRECK_PULL_MS = 900; // pull + derail + freeze + fade, one combined animation
const TURN_TIME_MS = 15000; // how long you have to act before your turn auto-passes

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
let targetDragState = null; // in-progress arc-targeting drag (Sabotage/Overcharge/Reinforce, or aiming a placed Wrecking Car)
let awaitingAim = null; // { cardId, handIdx, insertIndex } once a Wrecking Car is placed but not yet aimed
let stagedPlay = null; // { cardId, handIdx, target, insertIndex, refreshTarget } - what End Turn submits; null = pass
let phantomWrecks = []; // [{ side, car, index }] - cars still shown mid wreck-animation though matchState has already removed them
let myLastTrainWidth = null;
let oppLastTrainWidth = null;
let inTriggerPhase = false;
let pulsingIds = new Set(); // car ids to pulse on the next render, then cleared
let pulsingEngineSides = new Set(); // side keys ('host'/'client') whose engine box should pulse on the next render, then cleared
let blockRevealOverride = null; // { carId, displayCharges } - an Armor Car mid-block keeps showing its pre-hit charge count until the projectile lands
// { carHp: Map<carId, hp>, engineHp: { host, client } } during a trigger-phase
// reveal - each car/engine's own HP snapshot from before this stage, only
// advanced to its real post-hit value once that specific hit has landed, so
// a car doesn't show as damaged/junked before its own animation gets there.
let hpRevealOverride = null;
let bannerTimeout = null;
let turnTimeout = null; // fires endTurn() when the 15s turn clock runs out
let turnTickInterval = null; // updates the visible countdown every tick
let turnDeadline = null; // Date.now() timestamp the current turn auto-ends at
let myResolvedClawId = null; // real id of my just-coupled Wrecking Car, once resolveSetup has run this round
let oppResolvedClawId = null; // same, for the opponent's
let myClawWrecked = false; // whether my claw's target was actually destroyed this round (its own wreck animation takes over the line)
let oppClawWrecked = false;
let myAimLineEl = null; // persistent SVG line elements for the "targeting" indicator, one per side
let oppAimLineEl = null;

// Returns null (nothing new to preview) when this play would merge into an
// already-living car of the same type instead of coupling a new one - see
// MERGEABLE_HAND_TYPES and game.js's matching resolveSetup logic.
function pendingCarFor(cardId, side) {
  if (MERGEABLE_HAND_TYPES.includes(cardId) && matchState[side].cars.some((c) => c.type === cardId && c.hp > 0)) {
    return null;
  }
  if (cardId === 'wagon') return { type: 'wagon', dmgPerRound: 1, pending: true, hp: CARDS.wagon.maxHp, maxHp: CARDS.wagon.maxHp };
  if (cardId === 'sniper') return { type: 'sniper', dmgPerRound: 1, pending: true, hp: CARDS.sniper.maxHp, maxHp: CARDS.sniper.maxHp };
  if (cardId === 'armor') return { type: 'armor', blockCharges: 1, pending: true, hp: CARDS.armor.maxHp, maxHp: CARDS.armor.maxHp };
  if (cardId === 'repair') return { type: 'repair', healPerRound: 1, pending: true, hp: CARDS.repair.maxHp, maxHp: CARDS.repair.maxHp };
  if (cardId === 'claw') return { type: 'claw', pending: true, hp: CARDS.claw.maxHp, maxHp: CARDS.claw.maxHp };
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
  localStorage.removeItem(RESUME_ROOM_KEY); // a real match is starting now - this room's no longer "just waiting"
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
    handleOppPlayKnown(msg.card, msg.target, msg.insertIndex, msg.refreshTarget);
  }
});

net.addEventListener('close', () => {
  waitStatusEl.textContent = 'Opponent disconnected.';
  waitStatusEl.classList.remove('hidden');
});

function startMatch(seed) {
  clearTurnTimer();
  // Both peers derive the same battle-RNG seed from the same shared match
  // seed, so their random hit/heal targeting stays in lockstep.
  matchState = createMatchState(deriveSeed(seed, 'battle'));
  myDeck = createDeck(deriveSeed(seed, myRole));
  myHand = ensureWeapon(myDeck, [draw(myDeck), draw(myDeck)]);
  myHand = ensurePlayable(matchState, myRole, myDeck, myHand);
  if (vsBot) {
    botDeck = createDeck(deriveSeed(seed, oppRole));
    botHand = ensureWeapon(botDeck, [draw(botDeck), draw(botDeck)]);
    botHand = ensurePlayable(matchState, oppRole, botDeck, botHand);
  }
  myPlay = null;
  oppPlay = null;
  myPendingCar = null;
  myPendingInsertIndex = null;
  oppPendingCar = null;
  oppPendingInsertIndex = null;
  awaitingAim = null;
  stagedPlay = null;
  phantomWrecks = [];
  myLastTrainWidth = null;
  oppLastTrainWidth = null;
  inTriggerPhase = false;
  pulsingIds = new Set();
  pulsingEngineSides = new Set();
  hpRevealOverride = null;
  myResolvedClawId = null;
  oppResolvedClawId = null;
  myClawWrecked = false;
  oppClawWrecked = false;
  if (myAimLineEl) { myAimLineEl.remove(); myAimLineEl = null; }
  if (oppAimLineEl) { oppAimLineEl.remove(); oppAimLineEl = null; }
  resolving = false;
  gameOver = false;
  render();
  startTurnTimer();
}

function render() {
  roundInfoEl.textContent = inTriggerPhase ? 'Trigger Phase' : `Round ${matchState.round}`;
  const myTotal = computeHp(matchState, myRole);
  const oppTotal = computeHp(matchState, oppRole);
  renderHp(myHpEl, myHpFillEl, myTotal.hp, myTotal.maxHp);
  renderHp(oppHpEl, oppHpFillEl, oppTotal.hp, oppTotal.maxHp);
  renderTrains();
  renderHand();
}

function renderHp(labelEl, fillEl, hp, maxHp) {
  labelEl.textContent = `${hp}/${maxHp}`;
  const pct = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) * 100 : 0;
  fillEl.style.width = `${pct}%`;
  fillEl.classList.toggle('low', maxHp > 0 && hp <= maxHp * 0.3);
}

// A car/engine's own HP, honoring the trigger-phase reveal gating (see
// hpRevealOverride) - falls back to the live matchState value otherwise. A
// staged/committed Refresh on this car previews instantly, ahead of both.
function displayCarHp(car) {
  if (hpRevealOverride) return hpRevealOverride.carHp.get(car.id) ?? car.hp;
  const refreshPreview = myStagedRefreshPreview();
  if (refreshPreview && refreshPreview.carId === car.id) return refreshPreview.hp;
  return car.hp;
}
function displayEngineHp(side) {
  return hpRevealOverride ? hpRevealOverride.engineHp[side] : matchState[side].engine.hp;
}

// hpOverride, when given ({ my, opp }), positions the trains using those
// total-HP values instead of matchState's live ones - used mid-damage-
// animation, where matchState already holds the fully-resolved future state
// but the train on the rails shouldn't move until the hit that caused it has
// actually landed.
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

  // Cars a Wrecking Car just destroyed are already gone from matchState, but
  // still shown - about to derail - until their animation finishes.
  for (const pw of phantomWrecks) {
    if (pw.side === myRole) insertAt(myCars, pw.car, pw.index);
    else if (pw.side === oppRole) insertAt(oppCars, pw.car, pw.index);
  }

  const flagPreviews = myStagedFlagPreviews();
  const myEngine = { hp: displayEngineHp(myRole), maxHp: matchState[myRole].engine.maxHp, pulse: pulsingEngineSides.has(myRole), shielded: matchState[myRole].engine.shieldedThisRound };
  const oppEngine = { hp: displayEngineHp(oppRole), maxHp: matchState[oppRole].engine.maxHp, pulse: pulsingEngineSides.has(oppRole), shielded: matchState[oppRole].engine.shieldedThisRound };
  renderTrain(myTrainEl, myCars, myValidIds, flagPreviews.mine, myEngine);
  renderTrain(oppTrainEl, oppCars, oppValidIds, flagPreviews.opp, oppEngine);

  const myTotal = hpOverride ? hpOverride.my : computeHp(matchState, myRole).hp;
  const oppTotal = hpOverride ? hpOverride.opp : computeHp(matchState, oppRole).hp;
  const myMax = computeHp(matchState, myRole).maxHp;
  const oppMax = computeHp(matchState, oppRole).maxHp;
  myLastTrainWidth = positionTrain(myTrainEl, myTrackEl, myTotal, myMax, myLastTrainWidth);
  oppLastTrainWidth = positionTrain(oppTrainEl, oppTrackEl, oppTotal, oppMax, oppLastTrainWidth);

  updateAimLines();
}

// A Wrecking Car's target: shown the instant it's aimed (staged, before End
// Turn even) and kept on screen - through committing, waiting on the
// opponent, and the setup-phase reveal - until the trigger phase starts. A
// successful wreck hands the connection off to its own grapple-line/derail
// animation instead of keeping this line drawn on top of it.
function currentClawAim(side) {
  if (inTriggerPhase) return null;
  if (side === myRole) {
    if (stagedPlay && stagedPlay.cardId === 'claw') return { targetCarId: stagedPlay.target, wrecked: false };
    if (myPlay && myPlay.card === 'claw') return { targetCarId: myPlay.target, wrecked: myClawWrecked };
    return null;
  }
  if (oppPlay && oppPlay.card === 'claw') return { targetCarId: oppPlay.target, wrecked: oppClawWrecked };
  return null;
}

function clawAnchorEl(side) {
  const resolvedId = side === myRole ? myResolvedClawId : oppResolvedClawId;
  if (resolvedId != null) return carBoxEl(side, resolvedId);
  const container = side === myRole ? myTrainEl : oppTrainEl;
  return container.querySelector('.car-box.pending');
}

function updateAimLines() {
  updateOneAimLine('my', myRole, oppRole);
  updateOneAimLine('opp', oppRole, myRole);
}

function updateOneAimLine(which, side, targetSide) {
  const aim = currentClawAim(side);
  const fromEl = aim && !aim.wrecked ? clawAnchorEl(side) : null;
  const toEl = fromEl ? carBoxEl(targetSide, aim.targetCarId) : null;

  if (!fromEl || !toEl) {
    const existing = which === 'my' ? myAimLineEl : oppAimLineEl;
    if (existing) existing.remove();
    if (which === 'my') myAimLineEl = null;
    else oppAimLineEl = null;
    return;
  }

  let svg = which === 'my' ? myAimLineEl : oppAimLineEl;
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'aim-line');
    svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'line'));
    document.body.appendChild(svg);
    if (which === 'my') myAimLineEl = svg;
    else oppAimLineEl = svg;
  }

  const fromRect = fromEl.getBoundingClientRect();
  const toRect = toEl.getBoundingClientRect();
  const line = svg.querySelector('line');
  line.setAttribute('x1', fromRect.left + fromRect.width / 2);
  line.setAttribute('y1', fromRect.top + fromRect.height / 2);
  line.setAttribute('x2', toRect.left + toRect.width / 2);
  line.setAttribute('y2', toRect.top + toRect.height / 2);
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
function positionTrain(trainEl, trackEl, hp, maxHp, lastWidth) {
  const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
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

// Overcharge/Reinforce/Sabotage only flip a flag on an existing car - there's
// no new car to preview the way pendingCarFor() does for coupling cards. So
// this shows the flag itself the instant I choose the target (staged or
// already committed and waiting on the opponent), well before the real
// resolveSetup() actually runs and makes it true in matchState. This is only
// ever driven by MY OWN play - the opponent's own plays stay hidden until
// both sides have committed (see revealOppPendingIfReady()), even though
// Sabotage's target lands on their train from my perspective.
function myStagedFlagPreviews() {
  const play = stagedPlay || (myPlay && myPlay.card ? { cardId: myPlay.card, target: myPlay.target } : null);
  if (!play) return { mine: null, opp: null };
  if (play.cardId === 'overcharge') return { mine: { target: play.target, flag: 'overcharge' }, opp: null };
  if (play.cardId === 'reinforce') return { mine: { target: play.target, flag: 'shield' }, opp: null };
  if (play.cardId === 'sabotage') return { mine: null, opp: { target: play.target, flag: 'disabled' } };
  return { mine: null, opp: null };
}

// Same "show my own action instantly" idea as myStagedFlagPreviews, but for
// Refresh's HP/charge change rather than a flag overlay - mirrors exactly
// what resolveSetup's refresh handling will actually do once resolution
// runs, so there's nothing to reconcile once matchState catches up.
function myStagedRefreshPreview() {
  const play = stagedPlay || (myPlay && myPlay.card ? { cardId: myPlay.card, target: myPlay.target } : null);
  if (!play || play.cardId !== 'refresh') return null;
  const car = matchState[myRole].cars.find((c) => c.id === play.target);
  if (!car) return null;
  const hp = car.hp <= 0 ? Math.max(1, Math.ceil(car.maxHp / 2)) : car.maxHp;
  return { carId: car.id, hp, blockCharges: car.type === 'armor' ? 1 : null };
}

// One dot per point of max HP - bright red for HP still remaining, dark red
// for HP already lost. Used on both train cars and their hand-card previews.
function hpDots(hp, maxHp) {
  const wrap = document.createElement('div');
  wrap.className = 'hp-dots';
  for (let i = 0; i < maxHp; i++) {
    const dot = document.createElement('span');
    dot.className = `hp-dot ${i < hp ? 'filled' : 'empty'}`;
    wrap.appendChild(dot);
  }
  return wrap;
}

function renderTrain(el, cars, validIds, flagPreview, engineInfo) {
  el.innerHTML = '';

  // Cars trail behind the engine, which leads on the right - the train faces right.
  cars.forEach((car) => {
    const box = document.createElement('div');
    const pulse = car.id != null && pulsingIds.has(car.id);
    const refreshPreview = myStagedRefreshPreview();
    const previewingThisCar = refreshPreview && refreshPreview.carId === car.id;
    const displayBlockCharges =
      car.type === 'armor' && blockRevealOverride && car.id === blockRevealOverride.carId
        ? blockRevealOverride.displayCharges
        : previewingThisCar && refreshPreview.blockCharges != null
          ? refreshPreview.blockCharges
          : car.blockCharges;
    const hp = displayCarHp(car);
    const junk = hp <= 0;
    const spent = (car.type === 'armor' && displayBlockCharges <= 0) || (car.type === 'claw' && car.fired);
    const awaitingPlacementAim = car.pending && car.needsAim;
    box.className = `car-box ${car.type}${car.pending ? ' pending' : ''}${pulse ? ' pulse' : ''}${junk ? ' junk' : spent ? ' spent' : ''}`;
    if (car.id != null) box.dataset.carId = car.id;
    let stat;
    if (junk) stat = 'junk';
    else if (car.type === 'wagon') stat = car.dmgPerRound > 1 ? `${car.dmgPerRound} shots/rd` : '1 shot/rd';
    else if (car.type === 'sniper') stat = `${car.dmgPerRound}/rd · pierces`;
    else if (car.type === 'armor') stat = spent ? 'spent' : `${displayBlockCharges}x block`;
    else if (car.type === 'claw') stat = awaitingPlacementAim ? 'aim me' : spent ? 'spent' : 'armed';
    else stat = `+${car.healPerRound}/rd`;
    box.innerHTML = `<strong>${CARDS[car.type].name}</strong><span>${stat}</span>`;
    box.appendChild(hpDots(hp, car.maxHp));
    const previewFlag = flagPreview && flagPreview.target === car.id ? flagPreview.flag : null;
    const flagKinds = [];
    if (car.overcharged || previewFlag === 'overcharge') flagKinds.push('overcharge');
    if (car.protected || car.shieldedThisRound || previewFlag === 'shield') flagKinds.push('shield');
    if (car.disabledThisRound || previewFlag === 'disabled') flagKinds.push('disabled');
    if (flagKinds.length) {
      const flagRow = document.createElement('div');
      flagRow.className = 'car-flags';
      flagKinds.forEach((kind) => {
        const flag = document.createElement('div');
        flag.className = `car-flag ${kind}`;
        if (kind === 'overcharge') {
          flag.textContent = 'Overcharged';
        } else if (kind === 'disabled') {
          flag.textContent = 'Disabled';
        } else {
          const icon = document.createElement('div');
          icon.className = 'shield-icon';
          flag.appendChild(icon);
        }
        flagRow.appendChild(flag);
      });
      box.appendChild(flagRow);
    }
    if (validIds && car.id != null && validIds.has(car.id)) {
      box.classList.add('targetable');
      box.addEventListener('click', () => chooseTarget(car.id));
    }
    if (awaitingPlacementAim) {
      box.classList.add('needs-aim');
      box.addEventListener('pointerdown', (e) => startClawAim(e, box));
    }
    el.appendChild(box);
  });

  const engine = document.createElement('div');
  const engineJunk = engineInfo.hp <= 0;
  engine.className = `car-box engine${engineInfo.pulse ? ' pulse' : ''}${engineJunk ? ' junk' : ''}`;
  engine.innerHTML = `<strong>ENGINE</strong>`;
  if (engineInfo.shielded) {
    const flagRow = document.createElement('div');
    flagRow.className = 'car-flags';
    const flag = document.createElement('div');
    flag.className = 'car-flag shield';
    const icon = document.createElement('div');
    icon.className = 'shield-icon';
    flag.appendChild(icon);
    flagRow.appendChild(flag);
    engine.appendChild(flagRow);
  }
  engine.appendChild(hpDots(engineInfo.hp, engineInfo.maxHp));
  el.appendChild(engine);
}

// Low-key, always-current "what do I do now" line - covers whatever isn't
// already explained by a more prominent status (the target-area panel, the
// "Waiting for opponent" line, or the trigger-phase animations themselves).
function updateHint() {
  let text = '';
  if (gameOver || resolving) {
    text = '';
  } else if (dragState) {
    text = 'Drop it anywhere along your train.';
  } else if (targetDragState) {
    text = 'Drag to a target, then release to aim.';
  } else if (awaitingAim) {
    text = 'Drag from your Wrecking Car to aim it at an enemy car.';
  } else if (pendingPlay) {
    text = '';
  } else if (myPlay) {
    text = '';
  } else if (stagedPlay) {
    text = 'Staged - press End Turn to lock it in, or choose a different card.';
  } else {
    text = 'Play a card from your hand, or press End Turn to pass.';
  }
  hintTextEl.textContent = text;
}

function renderHand() {
  handEl.innerHTML = '';
  const locked = !!myPlay || !!pendingPlay || gameOver;
  btnPass.disabled = locked;
  if (locked) {
    btnPass.textContent = 'End Turn';
    btnPass.classList.remove('low-time');
  }
  const hasPlayedCard = !!stagedPlay || (!!myPlay && myPlay.card !== null);
  btnPass.classList.toggle('played', hasPlayedCard);
  waitStatusEl.classList.toggle('hidden', !myPlay || gameOver);
  if (oppPlay) waitStatusEl.textContent = 'Resolving...';
  else waitStatusEl.textContent = vsBot ? 'Bot is thinking...' : 'Waiting for opponent...';
  updateHint();

  myHand.forEach((cardId, idx) => {
    const card = CARDS[cardId];
    const btn = document.createElement('button');
    btn.className = 'card-btn';
    const needsTarget = !!card.target;
    const targets = needsTarget ? validTargets(matchState, myRole, cardId) : [];
    const disabled = locked || (needsTarget && targets.length === 0);
    btn.disabled = disabled;
    if (stagedPlay && stagedPlay.handIdx === idx) btn.classList.add('staged');
    const merging = MERGEABLE_HAND_TYPES.includes(cardId) && matchState[myRole].cars.some((c) => c.type === cardId && c.hp > 0);
    const desc = merging ? `${card.desc} - you already have one, so this upgrades it instead of coupling a new one` : card.desc;
    btn.innerHTML = `<strong>${card.name}</strong><span>${desc}</span>`;
    if (card.maxHp) btn.appendChild(hpDots(card.maxHp, card.maxHp));
    if (card.persistent && merging) {
      // Already have a living one of this type - playing it just upgrades
      // that one in place, so there's no position to choose (see game.js's
      // resolveSetup). A plain click is enough, same as an untargeted card.
      btn.addEventListener('click', () => stagePlay(cardId, idx, null));
    } else if (card.persistent) {
      // Train cars (wagon/armor/repair/claw): drag onto your train to
      // choose where in the order it couples on, instead of a plain click.
      // A Wrecking Car (claw) then needs a second drag - see onCardDragEnd.
      btn.classList.add('draggable');
      btn.addEventListener('pointerdown', (e) => startCardDrag(e, cardId, idx, btn));
    } else if (cardId === 'sabotage' || cardId === 'overcharge' || cardId === 'reinforce' || cardId === 'refresh') {
      // Drag out an arcing targeting reticle at the target car (enemy for
      // Sabotage, your own for Overcharge/Reinforce/Refresh) instead of a
      // two-step click. Refresh on a spent Wrecking Car chains into a second
      // drag to re-aim it - see startTargetedCardDrag.
      btn.classList.add('draggable');
      btn.addEventListener('pointerdown', (e) => startTargetedCardDrag(e, cardId, idx, btn));
    } else {
      btn.addEventListener('click', () => {
        if (needsTarget) {
          beginTargeting(cardId, idx);
        } else {
          stagePlay(cardId, idx, null);
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
  if (card.maxHp) ghost.appendChild(hpDots(card.maxHp, card.maxHp));
  document.body.appendChild(ghost);

  const indicator = document.createElement('div');
  indicator.className = 'insert-indicator';
  document.body.appendChild(indicator);

  dragState = { cardId, handIdx, ghost, indicator, insertIndex: null, overTrain: false, sourceBtn };
  moveGhost(e.clientX, e.clientY);
  updateDropTarget(e.clientX, e.clientY);
  updateHint();

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
  if (!overTrain) {
    updateHint();
    return; // dropped off the train, cancel - the card just stays in hand
  }

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
    stagePlay(cardId, handIdx, null, insertIndex);
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
  updateHint();

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

// Shared by any targeted, non-coupling card (Sabotage, Overcharge, Reinforced
// Coupling): drag an arcing reticle out from the hand card and release over a
// highlighted car - own or enemy, whichever validTargets() says this card
// can hit - instead of a plain click-to-target.
function startTargetedCardDrag(e, cardId, handIdx, sourceBtn) {
  if (sourceBtn.disabled || dragState || targetDragState) return;
  pendingPlay = { cardId, handIdx };
  renderTrains(); // safe: doesn't touch the hand DOM the pointer is captured on
  startArcTargeting(e, sourceBtn, (targetId) => {
    if (targetId == null) {
      pendingPlay = null;
      renderTrains();
      renderHand();
      return;
    }

    pendingPlay = null;
    stagePlay(cardId, handIdx, targetId);
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
      stagePlay(cardId, handIdx, targetId, insertIndex);
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
  stagePlay(cardId, handIdx, targetId);
}

targetCancelBtn.addEventListener('click', () => {
  pendingPlay = null;
  targetAreaEl.classList.add('hidden');
  renderTrains();
  renderHand();
});

btnPass.addEventListener('click', endTurn);

// Cleanly cancels whatever mid-flight (not-yet-staged) interaction the
// player was in - a train-car drag, an arc-targeting drag, or a Wrecking
// Car/Refresh placement that's been dropped but not yet aimed - so ending
// the turn can't leave stray state behind. A car that already finished
// staging (myPendingCar with no aim still pending) is left alone; that's
// what's about to be submitted, not something to abandon.
function abortInProgressInteractions() {
  if (dragState) {
    dragState.ghost.remove();
    dragState.indicator.remove();
    dragState.sourceBtn.removeEventListener('pointermove', onCardDragMove);
    dragState.sourceBtn.removeEventListener('pointerup', onCardDragEnd);
    dragState.sourceBtn.removeEventListener('pointercancel', onCardDragEnd);
    dragState = null;
  }
  if (targetDragState) {
    targetDragState.svg.remove();
    targetDragState.reticle.remove();
    targetDragState.sourceEl.removeEventListener('pointermove', onTargetDragMove);
    targetDragState.sourceEl.removeEventListener('pointerup', onTargetDragEnd);
    targetDragState.sourceEl.removeEventListener('pointercancel', onTargetDragEnd);
    targetDragState = null;
  }
  pendingPlay = null;
  if (awaitingAim) {
    // Placed but never aimed - it never became a real staged play, so its
    // preview goes too.
    myPendingCar = null;
    myPendingInsertIndex = null;
  }
  awaitingAim = null;
}

// Shared by the End Turn button and the 15s clock running out. Whatever is
// currently staged is what actually gets submitted; if nothing was staged,
// this round counts as a pass.
function endTurn() {
  clearTurnTimer();
  abortInProgressInteractions();

  const staged = stagedPlay;
  stagedPlay = null;

  if (staged) {
    commitPlay(staged.cardId, staged.handIdx, staged.target, staged.insertIndex, staged.refreshTarget);
    return;
  }

  myHand = redrawHand(myDeck, myHand);
  myPlay = { card: null, target: null };
  targetAreaEl.classList.add('hidden');
  revealOppPendingIfReady();
  renderTrains();
  renderHand();
  if (vsBot) {
    setTimeout(playBotTurn, BOT_DELAY_MS);
  } else {
    net.send({ t: 'play', card: null, target: null });
    runResolution();
  }
}

function startTurnTimer() {
  clearTurnTimer();
  turnDeadline = Date.now() + TURN_TIME_MS;
  updateTurnTimerDisplay();
  turnTickInterval = setInterval(updateTurnTimerDisplay, 250);
  turnTimeout = setTimeout(endTurn, TURN_TIME_MS);
}

function clearTurnTimer() {
  if (turnTimeout) clearTimeout(turnTimeout);
  if (turnTickInterval) clearInterval(turnTickInterval);
  turnTimeout = null;
  turnTickInterval = null;
  turnDeadline = null;
}

function updateTurnTimerDisplay() {
  if (!turnDeadline || btnPass.disabled) return;
  const secondsLeft = Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000));
  btnPass.textContent = `End Turn (${secondsLeft}s)`;
  btnPass.classList.toggle('low-time', secondsLeft <= 5);
}

function playBotTurn() {
  const botChoice = chooseBotPlay(matchState, oppRole, botHand);
  botHand.splice(botHand.indexOf(botChoice.card), 1);
  // bot always appends at the engine end; refreshTarget only matters when reviving a Wrecking Car
  handleOppPlayKnown(botChoice.card, botChoice.target, null, botChoice.refreshTarget);
}

// Records a choice locally without ending the turn: no network send, no
// lock-in. The player can keep browsing their hand and stage something else
// instead - only End Turn (button or the 15s clock) actually submits
// whatever's currently staged.
function stagePlay(cardId, handIdx, target, insertIndex, refreshTarget) {
  insertIndex = insertIndex ?? null;
  refreshTarget = refreshTarget ?? null;
  stagedPlay = { cardId, handIdx, target, insertIndex, refreshTarget };
  myPendingCar = pendingCarFor(cardId, myRole);
  myPendingInsertIndex = insertIndex;
  targetAreaEl.classList.add('hidden');
  renderTrains();
  renderHand();
}

// Actually submits a play over the network and starts resolution. Only ever
// called once per round, from endTurn() - never directly from a hand
// interaction anymore.
function commitPlay(cardId, handIdx, target, insertIndex, refreshTarget) {
  myHand.splice(handIdx, 1);
  insertIndex = insertIndex ?? null;
  refreshTarget = refreshTarget ?? null;
  myPlay = { card: cardId, target, insertIndex, refreshTarget };
  myPendingCar = pendingCarFor(cardId, myRole);
  myPendingInsertIndex = insertIndex;
  targetAreaEl.classList.add('hidden');
  revealOppPendingIfReady();
  renderTrains();
  renderHand();
  if (vsBot) {
    setTimeout(playBotTurn, BOT_DELAY_MS);
  } else {
    net.send({ t: 'play', card: cardId, target, insertIndex, refreshTarget });
    runResolution();
  }
}

// Opponent's play is known (bot decided, or a networked message arrived).
// No reveal popup, and nothing about their train previews on screen until
// my own play is also locked in - see revealOppPendingIfReady().
function handleOppPlayKnown(cardId, target, insertIndex, refreshTarget) {
  insertIndex = insertIndex ?? null;
  refreshTarget = refreshTarget ?? null;
  oppPlay = { card: cardId, target, insertIndex, refreshTarget };
  revealOppPendingIfReady();
  runResolution();
}

// Shows the opponent's pending car (if any) the instant BOTH plays are
// known - never before. Whichever of the two plays arrives second is what
// triggers this: if I already ended my turn, their play reveals as soon as
// it comes in; if they already played, mine reveals the moment I commit.
function revealOppPendingIfReady() {
  if (myPlay && oppPlay) {
    oppPendingCar = pendingCarFor(oppPlay.card, oppRole);
    oppPendingInsertIndex = oppPlay.insertIndex;
    render();
  }
}

// Runs once both plays are known: setup, then the trigger phase (one whole
// train's cars, in order, before the other's), each applied and rendered in
// turn with a short pause so the player can follow what happened, then a
// "Round N" banner before the next round unlocks.
async function runResolution() {
  if (!myPlay || !oppPlay || gameOver || resolving) return;
  resolving = true;

  const plays = { [myRole]: myPlay, [oppRole]: oppPlay };
  const beforeIds = {
    [myRole]: new Set(matchState[myRole].cars.map((c) => c.id)),
    [oppRole]: new Set(matchState[oppRole].cars.map((c) => c.id)),
  };

  const setup = resolveSetup(matchState, plays); // fully resolved now, including any Wrecking Car destroys
  myPendingCar = null;
  myPendingInsertIndex = null;
  oppPendingCar = null;
  oppPendingInsertIndex = null;

  // Pin down the real id of a Wrecking Car just coupled this round (it had
  // none while only a preview), so its aim line can keep tracking it, and
  // note whether it actually landed - a successful wreck's own animation
  // takes over the line instead of this one continuing to draw it.
  for (const side of [myRole, oppRole]) {
    const newClaw =
      plays[side].card === 'claw'
        ? matchState[side].cars.find((c) => c.type === 'claw' && !beforeIds[side].has(c.id))
        : null;
    const resolvedId = newClaw ? newClaw.id : null;
    const wrecked = resolvedId != null && setup.wrecks.some((w) => w.attackerCarId === resolvedId);
    if (side === myRole) {
      myResolvedClawId = resolvedId;
      myClawWrecked = wrecked;
    } else {
      oppResolvedClawId = resolvedId;
      oppClawWrecked = wrecked;
    }
  }

  if (setup.wrecks.length) {
    await playWreckAnimations(setup.wrecks);
  } else {
    render();
  }
  await wait(STAGE_MS);

  inTriggerPhase = true;
  const preTriggerHp = { host: computeHp(matchState, 'host').hp, client: computeHp(matchState, 'client').hp };
  // Snapshot every car/engine's own HP before the trigger phase mutates it -
  // renderTrains reads through this until each specific hit/heal "lands", so
  // a car doesn't look damaged/junked ahead of its own animation.
  const carHpSnapshot = new Map();
  for (const side of [myRole, oppRole]) for (const car of matchState[side].cars) carHpSnapshot.set(car.id, car.hp);
  hpRevealOverride = {
    carHp: carHpSnapshot,
    engineHp: { host: matchState.host.engine.hp, client: matchState.client.engine.hp },
  };
  const trigger = resolveTrigger(matchState, plays); // fully resolved now; revealed to the player hit by hit below
  await playTriggerEvents(trigger.events, preTriggerHp);
  hpRevealOverride = null;
  inTriggerPhase = false;
  render();
  finishRound(plays);
}

// Plays every Wrecking Car destroy from this round's setup phase (there can
// be one from each side at once). The destroyed cars are already gone from
// matchState, so they're temporarily shown again via phantomWrecks - a
// grapple line reaches out to each, then it's pulled off, derails, freezes,
// and fades, before the real (already-resolved) state finally renders.
async function playWreckAnimations(wrecks) {
  phantomWrecks = wrecks.map((w) => ({ side: w.targetSide, car: w.targetCarSnapshot, index: w.targetIndex }));
  pulsingIds = new Set(wrecks.map((w) => w.attackerCarId));
  renderTrains();
  pulsingIds = new Set();

  await Promise.all(wrecks.map(animateOneWreck));

  phantomWrecks = [];
  render();
}

async function animateOneWreck(wreck) {
  const attackerEl = carBoxEl(wreck.attackerSide, wreck.attackerCarId);
  const targetEl = carBoxEl(wreck.targetSide, wreck.targetCarId);
  if (!attackerEl || !targetEl) return;

  const fromRect = attackerEl.getBoundingClientRect();
  const toRect = targetEl.getBoundingClientRect();

  const grapple = createGrappleLine(fromRect, toRect);
  document.body.appendChild(grapple.svg);
  await growGrappleLine(grapple, WRECK_LINE_MS);

  const dx = fromRect.left + fromRect.width / 2 - (toRect.left + toRect.width / 2);
  const dy = fromRect.top + fromRect.height / 2 - (toRect.top + toRect.height / 2);
  const len = Math.hypot(dx, dy) || 1;
  targetEl.style.setProperty('--pull-x', `${(dx / len) * 22}px`);
  targetEl.style.setProperty('--pull-y', `${(dy / len) * 22}px`);
  targetEl.classList.add('wrecking');

  await wait(WRECK_PULL_MS);
  grapple.svg.remove();
}

function createGrappleLine(fromRect, toRect) {
  const x1 = fromRect.left + fromRect.width / 2;
  const y1 = fromRect.top + fromRect.height / 2;
  const x2 = toRect.left + toRect.width / 2;
  const y2 = toRect.top + toRect.height / 2;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'grapple-line');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', x1);
  line.setAttribute('y1', y1);
  line.setAttribute('x2', x2);
  line.setAttribute('y2', y2);
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  line.style.strokeDasharray = `${length}`;
  line.style.strokeDashoffset = `${length}`;
  svg.appendChild(line);
  return { svg, line };
}

function growGrappleLine(grapple, durationMs) {
  return new Promise((resolve) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      grapple.line.style.strokeDashoffset = '0';
      resolve();
      return;
    }
    void grapple.line.getBoundingClientRect(); // flush the starting dash offset before animating
    grapple.line.style.transition = `stroke-dashoffset ${durationMs}ms ease-out`;
    grapple.line.style.strokeDashoffset = '0';
    setTimeout(resolve, durationMs);
  });
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
function fireProjectile(fromEl, toEl, variant, durationMs) {
  return new Promise((resolve) => {
    if (!fromEl || !toEl) {
      resolve();
      return;
    }
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();

    const dot = document.createElement('div');
    dot.className = variant ? `projectile ${variant}` : 'projectile';
    dot.style.left = `${fromRect.left + fromRect.width / 2}px`;
    dot.style.top = `${fromRect.top + fromRect.height / 2}px`;
    document.body.appendChild(dot);

    if (reduceMotion) {
      dot.style.left = `${toRect.left + toRect.width / 2}px`;
      dot.style.top = `${toRect.top + toRect.height / 2}px`;
    } else {
      dot.style.transition = `left ${durationMs}ms linear, top ${durationMs}ms linear`;
      void dot.offsetWidth; // flush the starting position before animating
      dot.style.left = `${toRect.left + toRect.width / 2}px`;
      dot.style.top = `${toRect.top + toRect.height / 2}px`;
    }

    setTimeout(() => {
      dot.remove();
      resolve();
    }, durationMs);
  });
}

// Replays a resolved trigger phase event by event, one whole train (in
// position order) completely before the other starts, per resolveTrigger's
// side-major ordering. Wagon and sniper shots fire a projectile (sniper's
// smaller and faster) and only reveal their damage once it lands; heals and
// other sources just get a short beat. Next car doesn't trigger until the
// current one lands.
// `displayedHp` starts at each side's HP from before this stage (matchState
// itself is already fully resolved to the *end* of the stage by the time
// this runs) and is only advanced to an event's hpAfter once that event has
// actually landed - so neither the HP bar nor the train's position on the
// rails moves early.
async function playTriggerEvents(events, displayedHp) {
  const hpOverride = () => ({ my: displayedHp[myRole], opp: displayedHp[oppRole] });

  for (const event of events) {
    if (event.blocked) {
      const blockerCar = matchState[event.targetSide].cars.find((c) => c.id === event.blockedByCarId);
      if (blockerCar) blockRevealOverride = { carId: blockerCar.id, displayCharges: blockerCar.blockCharges + 1 };
    }

    if (event.kind === 'wagon' || event.kind === 'sniper') {
      pulsingIds = new Set([event.attackerCarId]);
      renderTrains(hpOverride());
      pulsingIds = new Set();
      const variant = event.kind === 'sniper' ? 'projectile-sniper' : null;
      const duration = event.kind === 'sniper' ? SNIPER_PROJECTILE_MS : PROJECTILE_MS;
      // A blocked shot flies at the armor car that intercepts it; otherwise
      // it flies at whichever car (or the engine) the hit actually landed on.
      const toEl = event.blocked
        ? carBoxEl(event.targetSide, event.blockedByCarId)
        : event.hitKind === 'car'
          ? carBoxEl(event.targetSide, event.hitCarId)
          : engineBoxEl(event.targetSide);
      await fireProjectile(carBoxEl(event.attackerSide, event.attackerCarId), toEl, variant, duration);
    } else {
      await wait(EVENT_PAUSE_MS);
    }

    // Landed - now it's safe to reveal the result.
    blockRevealOverride = null;
    displayedHp[event.targetSide] = event.hpAfter;
    if (hpRevealOverride) {
      if (event.hitKind === 'engine') hpRevealOverride.engineHp[event.targetSide] = event.targetHpAfter;
      else if (event.hitKind === 'car') hpRevealOverride.carHp.set(event.hitCarId, event.targetHpAfter);
    }
    if (event.blocked) pulsingIds = new Set([event.blockedByCarId]);
    else if (event.hitKind === 'car') pulsingIds = new Set([event.hitCarId]);
    else if (event.hitKind === 'engine') pulsingEngineSides = new Set([event.targetSide]);
    const hpEl = event.targetSide === myRole ? myHpEl : oppHpEl;
    const fillEl = event.targetSide === myRole ? myHpFillEl : oppHpFillEl;
    renderHp(hpEl, fillEl, event.hpAfter, computeHp(matchState, event.targetSide).maxHp);
    renderTrains(hpOverride());
    pulsingIds = new Set();
    pulsingEngineSides = new Set();

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
    myResolvedClawId = null;
    oppResolvedClawId = null;
    render();
    showGameOver(winner);
    return;
  }

  showRoundBanner(matchState.round);
  setTimeout(() => {
    resolving = false;
    myPlay = null;
    oppPlay = null;
    myResolvedClawId = null;
    oppResolvedClawId = null;
    render();
    startTurnTimer();
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

async function hostRoom(existingId) {
  btnHost.disabled = true;
  btnResumeHost.disabled = true;
  hostStatusEl.textContent = existingId ? 'Resuming room...' : 'Creating room...';
  try {
    const id = await net.host(existingId);
    localStorage.setItem(RESUME_ROOM_KEY, id);
    hostCodeWrap.classList.remove('hidden');
    hostCodeEl.textContent = formatRoomCode(id);
    hostStatusEl.textContent = 'Waiting for opponent to join...';
    hostCodeEl.addEventListener('click', () => {
      navigator.clipboard?.writeText(formatRoomCode(id)).catch(() => {});
    });
    setQuickActionVisibility(btnResumeHost, false);
  } catch (err) {
    // A stale resumed id can fail (e.g. long expired) - fall back to a fresh room next time.
    if (existingId) localStorage.removeItem(RESUME_ROOM_KEY);
    hostStatusEl.textContent = `Error: ${err.message || err}`;
    btnHost.disabled = false;
    btnResumeHost.disabled = false;
  }
}

async function joinRoom(code) {
  btnJoin.disabled = true;
  btnQuickJoin.disabled = true;
  joinStatusEl.textContent = 'Connecting...';
  try {
    await net.join(toPeerId(code));
    setQuickActionVisibility(btnQuickJoin, false);
  } catch (err) {
    joinStatusEl.textContent = `Error: ${err.message || err}`;
    btnJoin.disabled = false;
    btnQuickJoin.disabled = false;
  }
}

function setQuickActionVisibility(btn, visible) {
  btn.classList.toggle('hidden', !visible);
  const anyVisible = !btnResumeHost.classList.contains('hidden') || !btnQuickJoin.classList.contains('hidden');
  quickActionsEl.classList.toggle('hidden', !anyVisible);
}

// A room I created but nobody joined yet, from before a page reload - offer
// to bring the exact same code back up instead of forcing a brand new one.
const resumeId = localStorage.getItem(RESUME_ROOM_KEY);
if (resumeId) {
  resumeHostCodeEl.textContent = formatRoomCode(resumeId);
  setQuickActionVisibility(btnResumeHost, true);
}

// Best-effort: if a room code is sitting in the clipboard (a friend just
// shared one), offer a one-click join. Silently does nothing if the browser
// blocks clipboard reads without a prior gesture, or there's no permission.
navigator.clipboard?.readText().then((text) => {
  const code = text.replace(/\s+/g, '').toUpperCase().replace(/^ROOM-/, '');
  if (ROOM_CODE_RE.test(code)) {
    quickJoinCodeEl.textContent = code;
    setQuickActionVisibility(btnQuickJoin, true);
  }
}).catch(() => {});

btnHost.addEventListener('click', () => hostRoom());
btnResumeHost.addEventListener('click', () => hostRoom(resumeId));

btnJoin.addEventListener('click', () => {
  const code = joinCodeInput.value.trim();
  if (!code) {
    joinStatusEl.textContent = 'Enter a room code first.';
    return;
  }
  joinRoom(code);
});

btnQuickJoin.addEventListener('click', () => joinRoom(quickJoinCodeEl.textContent));

const PANEL_FADE_MS = 180; // must match .mode-panel's transition duration in style.css

function setMatchMode(mode) {
  if (matchMode === mode) return;
  resetConnectionUI(); // leaving either mode mid-attempt shouldn't leave a stale peer/connection behind
  matchMode = mode;
  btnModeAuto.classList.toggle('active', mode === 'autoMode');
  btnModeInvite.classList.toggle('active', mode === 'inviteMode');

  const fromEl = mode === 'autoMode' ? inviteModePanel : autoModePanel;
  const toEl = mode === 'autoMode' ? autoModePanel : inviteModePanel;
  crossfadePanels(fromEl, toEl);
}

// Fades the outgoing panel out, then swaps display and fades the incoming
// one back in - avoids the instant hard-cut feel of a plain class toggle.
function crossfadePanels(fromEl, toEl) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    fromEl.classList.add('hidden');
    toEl.classList.remove('hidden');
    return;
  }

  fromEl.classList.add('panel-fade');
  setTimeout(() => {
    fromEl.classList.add('hidden');
    fromEl.classList.remove('panel-fade');

    toEl.classList.add('panel-fade');
    toEl.classList.remove('hidden');
    void toEl.offsetWidth; // flush the faded-out starting state before animating in
    toEl.classList.remove('panel-fade');
  }, PANEL_FADE_MS);
}

// Tears down whatever connection attempt is in flight (either mode) and
// resets both panels back to their idle state - used both by autoMode's own
// Cancel button and when switching modes out from under an attempt.
function resetConnectionUI() {
  autoMatchGeneration++; // invalidates any in-flight findAutoMatch() loop
  net.destroy();

  btnAutoMatch.disabled = false;
  btnAutoMatch.classList.remove('hidden');
  btnAutoCancel.classList.add('hidden');
  autoStatusEl.textContent = '';

  btnHost.disabled = false;
  btnResumeHost.disabled = false;
  hostCodeWrap.classList.add('hidden');
  hostStatusEl.textContent = '';

  btnJoin.disabled = false;
  btnQuickJoin.disabled = false;
  joinStatusEl.textContent = '';
}

// autoMode: try to join whoever's already waiting at the shared lobby id; if
// nobody is, become the host of it myself. If the lobby's already got a
// pair in it (this peer id rejects extra connections - see network.js), keep
// retrying every few seconds until a spot opens up.
async function findAutoMatch() {
  const myGeneration = ++autoMatchGeneration;
  btnAutoMatch.disabled = true;
  btnAutoMatch.classList.add('hidden');
  btnAutoCancel.classList.remove('hidden');

  while (autoMatchGeneration === myGeneration) {
    autoStatusEl.textContent = 'Looking for a match...';
    try {
      await net.join(AUTO_LOBBY_ID, AUTO_JOIN_TIMEOUT_MS);
      return; // the 'connected' handler takes it from here
    } catch (joinErr) {
      if (autoMatchGeneration !== myGeneration) return;
    }

    try {
      await net.host(AUTO_LOBBY_ID);
      autoStatusEl.textContent = 'Waiting for an opponent to join...';
      return; // hosting now - 'connected' fires once someone joins
    } catch (hostErr) {
      if (autoMatchGeneration !== myGeneration) return;
    }

    autoStatusEl.textContent = "A match is already in progress here - waiting for a spot...";
    await wait(AUTO_RETRY_DELAY_MS);
  }
}

btnModeAuto.addEventListener('click', () => setMatchMode('autoMode'));
btnModeInvite.addEventListener('click', () => setMatchMode('inviteMode'));
btnAutoMatch.addEventListener('click', findAutoMatch);
btnAutoCancel.addEventListener('click', resetConnectionUI);

// local.html has no Practice/vs-Bot option and skips straight to matchmaking
// - nothing to choose, so there's no reason to make the player click Join
// Game themselves.
if (location.pathname.endsWith('local.html')) {
  findAutoMatch();
}
