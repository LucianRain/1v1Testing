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
let oppPendingCar = null; // same, for the opponent's just-revealed play
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
  return null;
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
    handleOppPlayKnown(msg.card, msg.target);
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
  oppPendingCar = null;
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

function renderTrains() {
  let myValidIds = null;
  let oppValidIds = null;

  if (pendingPlay) {
    const card = CARDS[pendingPlay.cardId];
    const ids = new Set(validTargets(matchState, myRole, pendingPlay.cardId));
    if (card.target === 'enemy_car') oppValidIds = ids;
    else myValidIds = ids;
  }

  const myCars = matchState[myRole].cars.slice();
  if (myPendingCar) myCars.push(myPendingCar);
  const oppCars = matchState[oppRole].cars.slice();
  if (oppPendingCar) oppCars.push(oppPendingCar);

  renderTrain(myTrainEl, myCars, myValidIds);
  renderTrain(oppTrainEl, oppCars, oppValidIds);

  myLastTrainWidth = positionTrain(myTrainEl, myTrackEl, matchState[myRole].hp, myLastTrainWidth);
  oppLastTrainWidth = positionTrain(oppTrainEl, oppTrackEl, matchState[oppRole].hp, oppLastTrainWidth);
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
    box.className = `car-box ${car.type}${car.pending ? ' pending' : ''}${pulse ? ' pulse' : ''}`;
    let stat;
    if (car.type === 'wagon') stat = `${car.dmgPerRound}/rd`;
    else if (car.type === 'armor') stat = `${car.blockCharges}x block`;
    else stat = `+${car.healPerRound}/rd`;
    box.innerHTML = `<strong>${CARDS[car.type].name}</strong><span>${stat}${car.protected ? ' · shielded' : ''}</span>`;
    if (validIds && car.id != null && validIds.has(car.id)) {
      box.classList.add('targetable');
      box.addEventListener('click', () => chooseTarget(car.id));
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
    btn.addEventListener('click', () => {
      if (needsTarget) {
        beginTargeting(cardId, idx);
      } else {
        commitPlay(cardId, idx, null);
      }
    });
    handEl.appendChild(btn);
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
  handleOppPlayKnown(botChoice.card, botChoice.target);
}

function commitPlay(cardId, handIdx, target) {
  myHand.splice(handIdx, 1);
  myPlay = { card: cardId, target };
  myPendingCar = pendingCarFor(cardId);
  targetAreaEl.classList.add('hidden');
  renderTrains();
  renderHand();
  if (vsBot) {
    setTimeout(playBotTurn, BOT_DELAY_MS);
  } else {
    net.send({ t: 'play', card: cardId, target });
    runResolution();
  }
}

// Opponent's play is known (bot decided, or a networked message arrived):
// show their new car instantly and reveal what they played, same as our own
// turn, before the actual resolution animation runs.
function handleOppPlayKnown(cardId, target) {
  oppPlay = { card: cardId, target };
  oppPendingCar = pendingCarFor(cardId);
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
  oppPendingCar = null;
  render();

  setTimeout(() => {
    inTriggerPhase = true;
    const heal = resolveHeal(matchState, plays);
    pulsingIds = new Set(heal.triggered);
    render();
    pulsingIds = new Set(); // consumed - don't let a later unrelated render replay it

    setTimeout(() => {
      const damage = resolveDamage(matchState, plays);
      pulsingIds = new Set(damage.triggered);
      render();
      pulsingIds = new Set();
      inTriggerPhase = false;
      finishRound(plays);
    }, STAGE_MS);
  }, STAGE_MS);
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
