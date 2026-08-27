import { PeerNetwork, formatRoomCode, toPeerId } from './network.js';
import { CARDS, MAX_HP, createDeck, draw, redrawHand, deriveSeed, createMatchState, resolveRound, validTargets, checkWinner } from './game.js';
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
const oppHpEl = document.getElementById('opp-hp');
const oppHpFillEl = document.getElementById('opp-hp-fill');
const oppTrainEl = document.getElementById('opp-train');
const handEl = document.getElementById('hand');
const btnPass = document.getElementById('btn-pass');
const targetAreaEl = document.getElementById('target-area');
const targetCancelBtn = document.getElementById('target-cancel');
const waitStatusEl = document.getElementById('wait-status');
const gameOverEl = document.getElementById('game-over');
const gameOverTextEl = document.getElementById('game-over-text');
const btnRestart = document.getElementById('btn-restart');

const net = new PeerNetwork();

let myRole = null; // 'host' | 'client'
let oppRole = null;
let matchState = null;
let myDeck = null;
let myHand = [];
let myPlay = null;
let oppPlay = null;
let gameOver = false;
let vsBot = false;
let botDeck = null;
let botHand = [];
let pendingPlay = null; // { cardId, handIdx } while picking a target on the field

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
    oppPlay = { card: msg.card, target: msg.target };
    tryResolve();
  }
});

net.addEventListener('close', () => {
  waitStatusEl.textContent = 'Opponent disconnected.';
  waitStatusEl.classList.remove('hidden');
});

function startMatch(seed) {
  matchState = createMatchState();
  myDeck = createDeck(deriveSeed(seed, myRole));
  myHand = [draw(myDeck), draw(myDeck), draw(myDeck)];
  if (vsBot) {
    botDeck = createDeck(deriveSeed(seed, oppRole));
    botHand = [draw(botDeck), draw(botDeck), draw(botDeck)];
  }
  myPlay = null;
  oppPlay = null;
  gameOver = false;
  render();
}

function render() {
  roundInfoEl.textContent = `Round ${matchState.round}`;
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

  renderTrain(myTrainEl, matchState[myRole].cars, myValidIds);
  renderTrain(oppTrainEl, matchState[oppRole].cars, oppValidIds);
}

function renderTrain(el, cars, validIds) {
  el.innerHTML = '';

  // Cars trail behind the engine, which leads on the right - the train faces right.
  cars.forEach((car) => {
    const box = document.createElement('div');
    box.className = `car-box ${car.type}`;
    const stat = car.type === 'wagon' ? `${car.dmgPerRound}/rd` : `${car.blockCharges}x block`;
    box.innerHTML = `<strong>${CARDS[car.type].name}</strong><span>${stat}${car.protected ? ' · shielded' : ''}</span>`;
    if (validIds && validIds.has(car.id)) {
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
  waitStatusEl.textContent = 'Waiting for opponent...';

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
  if (vsBot) {
    const botChoice = chooseBotPlay(matchState, oppRole, botHand);
    botHand.splice(botHand.indexOf(botChoice.card), 1);
    oppPlay = botChoice;
  } else {
    net.send({ t: 'play', card: null, target: null });
  }
  targetAreaEl.classList.add('hidden');
  renderHand();
  tryResolve();
});

function commitPlay(cardId, handIdx, target) {
  myHand.splice(handIdx, 1);
  myPlay = { card: cardId, target };
  if (vsBot) {
    const botChoice = chooseBotPlay(matchState, oppRole, botHand);
    botHand.splice(botHand.indexOf(botChoice.card), 1);
    oppPlay = botChoice;
  } else {
    net.send({ t: 'play', card: cardId, target });
  }
  targetAreaEl.classList.add('hidden');
  renderHand();
  tryResolve();
}

function tryResolve() {
  if (!myPlay || !oppPlay || gameOver) return;

  const plays = { [myRole]: myPlay, [oppRole]: oppPlay };
  const myCardPlayed = myPlay.card !== null;
  const oppCardPlayed = oppPlay.card !== null;
  resolveRound(matchState, plays);
  if (myCardPlayed) myHand.push(draw(myDeck));
  if (vsBot && oppCardPlayed) botHand.push(draw(botDeck));
  myPlay = null;
  oppPlay = null;

  const winner = checkWinner(matchState);
  if (winner) {
    gameOver = true;
    render();
    showGameOver(winner);
    return;
  }

  render();
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
