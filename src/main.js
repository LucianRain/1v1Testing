import { PeerNetwork, formatRoomCode, toPeerId } from './network.js';
import { CARDS, createDeck, draw, deriveSeed, createMatchState, resolveRound, validTargets, checkWinner } from './game.js';

const menuOverlay = document.getElementById('menu-overlay');
const gameScreen = document.getElementById('game-screen');

const btnHost = document.getElementById('btn-host');
const btnJoin = document.getElementById('btn-join');
const hostCodeWrap = document.getElementById('host-code-wrap');
const hostCodeEl = document.getElementById('host-code');
const hostStatusEl = document.getElementById('host-status');
const joinCodeInput = document.getElementById('join-code-input');
const joinStatusEl = document.getElementById('join-status');

const roundInfoEl = document.getElementById('round-info');
const myHpEl = document.getElementById('my-hp');
const myCarsEl = document.getElementById('my-cars');
const oppHpEl = document.getElementById('opp-hp');
const oppCarsEl = document.getElementById('opp-cars');
const handEl = document.getElementById('hand');
const targetAreaEl = document.getElementById('target-area');
const targetListEl = document.getElementById('target-list');
const targetCancelBtn = document.getElementById('target-cancel');
const waitStatusEl = document.getElementById('wait-status');
const logEl = document.getElementById('log');
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
  myPlay = null;
  oppPlay = null;
  gameOver = false;
  logEl.innerHTML = '';
  render();
}

function render() {
  roundInfoEl.textContent = `Round ${matchState.round}`;
  myHpEl.textContent = `You: ${matchState[myRole].hp} HP`;
  oppHpEl.textContent = `Opponent: ${matchState[oppRole].hp} HP`;
  myCarsEl.textContent = carsSummary(matchState[myRole].cars);
  oppCarsEl.textContent = carsSummary(matchState[oppRole].cars);
  renderHand();
}

function carsSummary(cars) {
  if (!cars.length) return 'No coupled cars.';
  return cars
    .map((c) => {
      const bits = [c.type === 'wagon' ? `${c.dmgPerRound} dmg/rd` : `${c.blockCharges} charge(s)`];
      if (c.protected) bits.push('protected');
      return `${c.type} (${bits.join(', ')})`;
    })
    .join(' · ');
}

function renderHand() {
  handEl.innerHTML = '';
  targetAreaEl.classList.add('hidden');
  const locked = !!myPlay || gameOver;
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
        showTargetPicker(cardId, idx, targets);
      } else {
        commitPlay(cardId, idx, null);
      }
    });
    handEl.appendChild(btn);
  });
}

function showTargetPicker(cardId, handIdx, targets) {
  targetAreaEl.classList.remove('hidden');
  targetListEl.innerHTML = '';
  const card = CARDS[cardId];
  const pool = card.target === 'enemy_car' ? matchState[oppRole].cars : matchState[myRole].cars;

  targets.forEach((targetId) => {
    const car = pool.find((c) => c.id === targetId);
    const btn = document.createElement('button');
    btn.className = 'card-btn';
    btn.textContent = `${car.type} #${car.id}`;
    btn.addEventListener('click', () => commitPlay(cardId, handIdx, targetId));
    targetListEl.appendChild(btn);
  });
}

targetCancelBtn.addEventListener('click', () => {
  targetAreaEl.classList.add('hidden');
});

function commitPlay(cardId, handIdx, target) {
  myHand.splice(handIdx, 1);
  myPlay = { card: cardId, target };
  net.send({ t: 'play', card: cardId, target });
  targetAreaEl.classList.add('hidden');
  renderHand();
  tryResolve();
}

function tryResolve() {
  if (!myPlay || !oppPlay || gameOver) return;

  const plays = { [myRole]: myPlay, [oppRole]: oppPlay };
  resolveRound(matchState, plays);
  myHand.push(draw(myDeck));
  myPlay = null;
  oppPlay = null;

  matchState.log.forEach((line) => appendLog(line));

  const winner = checkWinner(matchState);
  if (winner) {
    gameOver = true;
    render();
    showGameOver(winner);
    return;
  }

  render();
}

function appendLog(line) {
  const p = document.createElement('p');
  p.textContent = line;
  logEl.appendChild(p);
  logEl.scrollTop = logEl.scrollHeight;
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
