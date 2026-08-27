import { PeerNetwork, formatRoomCode, toPeerId } from './network.js';

const menuOverlay = document.getElementById('menu-overlay');
const counterScreen = document.getElementById('counter-screen');
const counterValueEl = document.getElementById('counter-value');
const connStatusEl = document.getElementById('conn-status');
const btnIncrement = document.getElementById('btn-increment');

const btnHost = document.getElementById('btn-host');
const btnJoin = document.getElementById('btn-join');
const hostCodeWrap = document.getElementById('host-code-wrap');
const hostCodeEl = document.getElementById('host-code');
const hostStatusEl = document.getElementById('host-status');
const joinCodeInput = document.getElementById('join-code-input');
const joinStatusEl = document.getElementById('join-status');

const net = new PeerNetwork();
let count = 0;

function render() {
  counterValueEl.textContent = count;
}

net.addEventListener('connected', () => {
  menuOverlay.classList.add('hidden');
  counterScreen.classList.remove('hidden');
  connStatusEl.textContent = 'Connected';
  render();
});

net.addEventListener('data', (e) => {
  if (e.detail.t === 'inc') {
    count += 1;
    render();
  }
});

net.addEventListener('close', () => {
  connStatusEl.textContent = 'Opponent disconnected';
});

btnIncrement.addEventListener('click', () => {
  count += 1;
  render();
  net.send({ t: 'inc' });
});

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
