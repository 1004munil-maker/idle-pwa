// ---- State ----
const SKEY = 'idle-bells-state';
const nowSec = () => Math.floor(Date.now()/1000);

function calcCost(base, rate, level) {
  return Math.max(base, Math.floor(base * Math.pow(rate, level)));
}

const init = () => ({
  coins: 0, cps: 0, tap: 1,
  workerLv: 0, tapLv: 0,
  last: nowSec()
});

function load() {
  try { return applyOffline(JSON.parse(localStorage.getItem(SKEY)) || init()); }
  catch { return init(); }
}

function save(s) {
  localStorage.setItem(SKEY, JSON.stringify({ ...s, last: nowSec() }));
}

function applyOffline(s) {
  const diff = Math.max(0, nowSec() - (s.last||nowSec()));
  return { ...s, coins: s.coins + diff * s.cps, last: nowSec() };
}

// ---- Game ----
let state = load();

const els = {
  coins: document.getElementById('coins'),
  cps:   document.getElementById('cps'),
  tap:   document.getElementById('tap'),
  workerCost: document.getElementById('workerCost'),
  tapCost: document.getElementById('tapCost'),
  tapBtn: document.getElementById('tapBtn'),
  buyWorker: document.getElementById('buyWorker'),
  buyTap: document.getElementById('buyTap'),
  save: document.getElementById('saveBtn')
};

function workerCost() { return calcCost(10, 1.15, state.workerLv); }
function tapCost() { return calcCost(8, 1.2, state.tapLv); }

function render() {
  els.coins.textContent = state.coins;
  els.cps.textContent = state.cps;
  els.tap.textContent = state.tap;
  els.workerCost.textContent = workerCost();
  els.tapCost.textContent = tapCost();
}

els.tapBtn.addEventListener('click', () => {
  state.coins += state.tap;
  render();
});

els.buyWorker.addEventListener('click', () => {
  const c = workerCost();
  if (state.coins >= c) {
    state.coins -= c;
    state.cps += 1;
    state.workerLv += 1;
    render();
  }
});

els.buyTap.addEventListener('click', () => {
  const c = tapCost();
  if (state.coins >= c) {
    state.coins -= c;
    state.tap += 1;
    state.tapLv += 1;
    render();
  }
});

els.save.addEventListener('click', () => save(state));

// tick
setInterval(() => {
  state.coins += state.cps;
  render();
}, 1000);

// autosave
setInterval(() => save(state), 5000);

render();