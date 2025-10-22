/* =========================================================
   Idle Lightning - game.js (Progression v3 + Player HP + API)
   ---------------------------------------------------------
   機能:
   - ステージ/章/階（30章でHP係数×1.5）
   - 10面は夜：敵HP×2、10%でダイヤ
   - 自分HPバー（衝突/突破で減少、0で章頭リトライ）
   - 敵3種アイコン：🦂 swarm / 🦅 runner / 🦏 tank
   - ビーム連鎖攻撃（減衰）
   - 外部拡張用 GameAPI を公開（upgrades.js から利用）
   ========================================================= */

/* (1) ---------- DOM参照 ---------- */
const laneEl   = document.getElementById('enemy-lane');
const logEl    = document.getElementById('log');
const goldEl   = document.getElementById('gold');
const diaEl    = document.getElementById('diamond');
const dpsEl    = document.getElementById('dps');
const chainEl  = document.getElementById('chain');
const spiritEl = document.querySelector('.spirit');
const playerHpBarEl   = document.getElementById('player-hp');
const playerHpFillEl  = playerHpBarEl?.querySelector('.fill');
const playerHpLabelEl = document.getElementById('playerHpLabel');
const stageLabelEl    = document.getElementById('stageLabel');

// スタート画面
const startScreenEl  = document.getElementById('start-screen');
const btnNew         = document.getElementById('btn-new');
const btnContinue    = document.getElementById('btn-continue');
const continueHintEl = document.getElementById('continue-hint');

// メニュー（任意：一時停止/再開/リトライ）
const btnPause  = document.getElementById('btn-pause');
const btnResume = document.getElementById('btn-resume');
const btnRetry  = document.getElementById('btn-retry');

/* (2) ---------- レイアウト計測 ---------- */
let laneRect;
function measureRects(){ laneRect = laneEl.getBoundingClientRect(); }
window.addEventListener('resize', measureRects);
window.addEventListener('orientationchange', () => setTimeout(measureRects, 200));

/* (3) ---------- ログ ---------- */
const MAX_LOG = 50;
function addLog(msg, kind = 'info') {
  const div = document.createElement('div');
  div.className = `log-entry ${kind}`;
  div.textContent = msg;
  if (logEl.firstChild) logEl.insertBefore(div, logEl.firstChild);
  else logEl.appendChild(div);
  while (logEl.childNodes.length > MAX_LOG) logEl.removeChild(logEl.lastChild);
}
function logAttack(chainCount, totalDamage) {
  addLog(`連鎖×${chainCount}！ 合計 ${Math.round(totalDamage)} ダメージ`, 'gain');
}

/* (4) ---------- セーブ/ロード ---------- */
const SAVE_KEY = 'idleLightningSaveV4';
function saveGame() {
  const data = {
    ts: Date.now(),
    gold, diamonds,
    floor: gs.floor, chapter: gs.chapter, stage: gs.stage, isNight: gs.isNight,
    hpScale: gs.hpScale,
    playerHp, playerHpMax,
    lightning: { baseDmg: lightning.baseDmg, cooldown: lightning.cooldown, range: lightning.range, chainCount: lightning.chainCount }
  };
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
}
function loadGame() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function hasSave() { return !!localStorage.getItem(SAVE_KEY); }

/* (5) ---------- ゲームステート ---------- */
const gs = {
  floor: 1,        // 1F から
  chapter: 1,      // 1..30
  stage: 1,        // 1..10（10が夜）
  isNight: false,  // stage===10 のとき true
  hpScale: 1.0,    // 階層で上がる（1F→1.0, 2F→1.5, 3F→2.25...）
  paused: false,
  running: false
};

// 通貨/UI
let gold = 0;
let diamonds = 0;
let dpsSmoothed = 0;
function refreshCurrencies(){
  goldEl.textContent = gold;
  diaEl.textContent  = diamonds;
  dpsEl.textContent  = Math.round(dpsSmoothed);
}
refreshCurrencies();

// プレイヤーHP（表示も）
let playerHpMax = 100;
let playerHp    = playerHpMax;
function updatePlayerHpUI(){
  const ratio = Math.max(0, Math.min(1, playerHp / playerHpMax));
  if (playerHpFillEl) playerHpFillEl.style.width = (ratio * 100).toFixed(1) + '%';
  if (playerHpLabelEl) playerHpLabelEl.textContent = `${Math.max(0,Math.ceil(playerHp))}/${playerHpMax}`;
}
updatePlayerHpUI();

/* (6) ---------- 進行UI更新 ---------- */
function updateStageLabel() {
  if (stageLabelEl) stageLabelEl.textContent = `${gs.chapter}-${gs.stage} / ${gs.floor}F${gs.isNight ? ' 🌙' : ''}`;
}
updateStageLabel();

/* (7) ---------- 雷 & 判定 ---------- */
const lightning = {
  baseDmg: 8,
  cooldown: 0.70,  // 秒
  timer: 0,
  range: 380,
  chainCount: 2,     // =3体ヒット
  falloff: 0.85
};
chainEl.textContent = `${lightning.chainCount}/15`;
const R_SPIRIT = 18; // 画面座標の半径
const R_ENEMY  = 13;

/* (8) ---------- 敵タイプ/プール/配列 ---------- */
const ENEMY_TYPES = {
  swarm:  { speed:120, hp: 20, reward: 1, dmg:  8 }, // 🦂
  runner: { speed:170, hp: 14, reward: 1, dmg: 10 }, // 🦅
  tank:   { speed: 90, hp: 90, reward: 5, dmg: 20 }  // 🦏
};
const ENEMY_ICONS = { swarm: "🦂", runner: "🦅", tank: "🦏" };
const SPAWN_WEIGHTS = [
  { type: 'swarm',  w: 0.60 },
  { type: 'runner', w: 0.25 },
  { type: 'tank',   w: 0.15 }
];
function pickEnemyType() {
  const r = Math.random(); let acc = 0;
  for (const x of SPAWN_WEIGHTS) { acc += x.w; if (r <= acc) return x.type; }
  return 'swarm';
}

// 敵プール
const enemyPool = [];
function getEnemyEl() {
  const el = enemyPool.pop();
  if (el) return el;
  const e = document.createElement('div');
  e.className = 'enemy';
  const icon = document.createElement('span'); icon.className = 'icon';
  const hp = document.createElement('div');   hp.className = 'hp';
  e.append(icon, hp);
  return e;
}
function releaseEnemyEl(el) { el.remove(); enemyPool.push(el); }
const enemies = [];  // {el,type,x,y,vx,vy,speed,hp,maxHp,reward,dmg,t,swayAmp,swayFreq}

/* (9) ---------- ステージ・係数 ---------- */
function stageTotalCount(chapter, stage) {
  const base = 8 + (stage - 1);              // 1-1:8 → 1-9:16 → 1-10:17
  return (stage === 10) ? Math.round(base * 2) : base;
}
function hpMultiplier() { return gs.hpScale * (gs.isNight ? 2.0 : 1.0); }
const MAX_CONCURRENT = 40;
const NIGHT_DIAMOND_RATE = 0.10;

// ステージカウンタ
let spawnPlan = { total: 0, spawned: 0, alive: 0 };

/* (10) ---------- スポーン制御 ---------- */
let laneWidthCached = 0, laneHeightCached = 0;
function spawnEnemy(type = pickEnemyType()) {
  if (!laneRect) measureRects();
  laneWidthCached  = laneRect.width;
  laneHeightCached = laneRect.height;

  const t  = ENEMY_TYPES[type];
  const el = getEnemyEl();
  laneEl.appendChild(el);

  // アイコン保証
  let iconEl = el.querySelector('.icon');
  if (!iconEl) { iconEl = document.createElement('span'); iconEl.className='icon'; el.prepend(iconEl); }
  iconEl.textContent = ENEMY_ICONS[type] || '👾';

  // 出現位置
  const startX = laneWidthCached - 60 - Math.random() * 40;
  const startY = Math.max(16, Math.min(
    laneHeightCached - 16,
    laneHeightCached * (0.10 + 0.80 * Math.random())
  ));

  // HPスケール
  const hpMul = hpMultiplier();
  const hpMax = Math.max(1, Math.round(t.hp * hpMul));

  // 初期描画
  el.style.transform = `translate(${startX}px, ${startY}px)`;
  el.querySelector('.hp').style.width = '100%';
  el.setAttribute('data-hp', hpMax);

  // 配列登録
  enemies.push({
    el, type,
    x: startX, y: startY,
    vx: 0, vy: 0,
    speed: t.speed,
    hp: hpMax, maxHp: hpMax,
    reward: t.reward, dmg: t.dmg,
    t: 0,
    swayAmp: 6 + Math.random()*10,
    swayFreq: 1.0 + Math.random()*0.8
  });

  spawnPlan.spawned++;
  spawnPlan.alive++;
}

// ディレイ調整
let spawnTimer = 0;
let baseSpawnDelay = 800; // ms
function trySpawn(dt) {
  if (spawnPlan.spawned >= spawnPlan.total) return;
  if (spawnPlan.alive   >= MAX_CONCURRENT) return;
  spawnTimer += dt * 1000;
  const dynamicDelay = baseSpawnDelay + Math.max(0, (spawnPlan.alive - 10) * 10);
  if (spawnTimer >= dynamicDelay) {
    spawnTimer = 0;
    spawnEnemy();
  }
}

/* (11) ---------- ビーム演出 ---------- */
const beamPool = [];
function getBeamEl(){ const el = beamPool.pop(); if(el) return el; const b=document.createElement('div'); b.className='beam'; return b; }
function releaseBeamEl(el){ el.remove(); beamPool.push(el); }
function spawnBeam(x1, y1, x2, y2, life = 0.12) {
  const el = getBeamEl();
  laneEl.appendChild(el);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx) * 180 / Math.PI;
  el.style.left = `${x1}px`;
  el.style.top  = `${y1}px`;
  el.style.width = `${Math.max(1, len)}px`;
  el.style.transform = `rotate(${ang}deg)`;
  setTimeout(() => el.classList.add('fade'), (life * 1000 * 0.6) | 0);
  setTimeout(() => { el.classList.remove('fade'); releaseBeamEl(el); }, (life * 1000) | 0);
}

/* (12) ---------- 攻撃（連鎖） ---------- */
function centerScreen(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2 };
}
function dist2(ax, ay, bx, by){ const dx=ax-bx, dy=ay-by; return dx*dx + dy*dy; }

function tryAttack(dt) {
  lightning.timer -= dt;
  if (lightning.timer > 0) return;

  const sc = centerScreen(spiritEl);
  const sx = sc.x - laneRect.left;
  const sy = sc.y - laneRect.top;

  const r2 = lightning.range * lightning.range;
  const cand = [];
  for (const e of enemies) {
    const d2 = dist2(sx, sy, e.x, e.y);
    if (d2 <= r2) cand.push({ e, d2 });
  }
  if (!cand.length) return;

  cand.sort((a,b)=>a.d2-b.d2);
  const maxHits = Math.min(lightning.chainCount + 1, cand.length);

  const used = new Set();
  let dmg = lightning.baseDmg;
  let dealtTotal = 0;

  const first = cand[0].e;
  spawnBeam(sx, sy, first.x, first.y);
  used.add(first);

  let prev = first;
  for (let i = 0; i < maxHits; i++) {
    const target = (i === 0) ? first : cand.find(o => !used.has(o.e))?.e;
    if (!target) break;

    if (i > 0) spawnBeam(prev.x, prev.y, target.x, target.y);

    target.hp -= dmg;
    dealtTotal += Math.max(0, dmg);

    const ratio = Math.max(0, target.hp / target.maxHp);
    target.el.querySelector('.hp').style.width = (ratio * 100).toFixed(1) + '%';
    target.el.setAttribute('data-hp', Math.max(0, Math.round(target.hp)));

    target.el.classList.add('hit');
    setTimeout(()=>target.el.classList.remove('hit'), 80);

    used.add(target);
    prev = target;
    dmg *= lightning.falloff;
  }

  // 撃破処理
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.hp <= 0) {
      if (gs.isNight && Math.random() < NIGHT_DIAMOND_RATE) {
        diamonds++; diaEl.textContent = diamonds;
        addLog('💎 ダイヤを獲得！', 'gain');
      }
      gold += e.reward; goldEl.textContent = gold;
      e.el.classList.add('dead');
      setTimeout(()=>releaseEnemyEl(e.el), 220);
      enemies.splice(i, 1);
      spawnPlan.alive--;
    }
  }

  logAttack(used.size, dealtTotal);
  lightning.timer = lightning.cooldown;
}

/* (13) ---------- ループ（移動/衝突/突破=被ダメ） ---------- */
let last = performance.now();

function getSpiritCenter(){ return centerScreen(spiritEl); }
function getEnemyCenter(e){ return centerScreen(e.el); }

function damagePlayer(amount){
  playerHp = Math.max(0, playerHp - amount);
  updatePlayerHpUI();
  if (playerHp <= 0) {
    addLog('💥 HPが0になった…章の初めからリトライ！', 'alert');
    failStage();
  }
}

function gameLoop(now = performance.now()) {
  let dt = (now - last) / 1000; last = now;
  dt = Math.min(dt, 0.033);

  if (!gs.running || gs.paused) { requestAnimationFrame(gameLoop); return; }

  if (!laneRect || laneRect.width === 0) measureRects();

  const sc = getSpiritCenter();

  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    e.t += dt;

    // 精霊の lane 座標（クランプ）
    let sxLane = sc.x - laneRect.left;
    let syLane = sc.y - laneRect.top;
    sxLane = Math.max(0, Math.min(laneRect.width,  sxLane));
    syLane = Math.max(0, Math.min(laneRect.height, syLane));

    // ステアリング
    let dx = sxLane - e.x, dy = syLane - e.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;

    const desiredVx = dx * e.speed;
    const desiredVy = dy * e.speed;

    const steer = 0.5;
    e.vx += (desiredVx - e.vx) * steer;
    e.vy += (desiredVy - e.vy) * steer;

    // 速度クランプ
    const vmax = e.speed * 1.2;
    const vlen = Math.hypot(e.vx, e.vy) || 1;
    if (vlen > vmax) { const s = vmax / vlen; e.vx *= s; e.vy *= s; }

    // サイン揺れ
    const sway = Math.sin(e.t * (2 * Math.PI * e.swayFreq)) * e.swayAmp;

    // 位置更新
    e.x += e.vx * dt;
    e.y += (e.vy + sway * 0.8) * dt;

    // DOM反映
    e.el.style.transform = `translate(${e.x}px, ${e.y}px)`;

    // 衝突（被ダメ）→ 敵は消滅
    const ec = getEnemyCenter(e);
    const dist = Math.hypot(sc.x - ec.x, sc.y - ec.y);
    if (dist <= (R_SPIRIT + R_ENEMY)) {
      addLog(`⚠️ 被弾：${e.type}（-${e.dmg} HP）`, 'alert');
      damagePlayer(e.dmg);
      releaseEnemyEl(e.el);
      enemies.splice(i, 1);
      spawnPlan.alive--;
      continue;
    }

    // 画面外（突破）→ 少量被ダメ
    const br = laneRect;
    const marginX = 120, marginY = 160;
    if (ec.x < br.left - marginX || ec.x > br.right + marginX ||
        ec.y < br.top  - marginY || ec.y > br.bottom + marginY) {
      const escDmg = Math.ceil(e.dmg * 0.5);
      addLog(`突破（escape）：${e.type}（-${escDmg} HP）`, 'alert');
      damagePlayer(escDmg);
      releaseEnemyEl(e.el);
      enemies.splice(i, 1);
      spawnPlan.alive--;
      continue;
    }
  }

  // 攻撃・スポーン・クリア判定
  tryAttack(dt);
  trySpawn(dt);
  if (spawnPlan.spawned >= spawnPlan.total && spawnPlan.alive <= 0 && enemies.length === 0) {
    nextStage();
  }

  requestAnimationFrame(gameLoop);
}

/* (14) ---------- ステージ遷移 ---------- */
function setupStageCounters() {
  spawnPlan.total   = stageTotalCount(gs.chapter, gs.stage);
  spawnPlan.spawned = 0;
  spawnPlan.alive   = 0;
  spawnTimer = 0;
  updateStageLabel();
  addLog(`Stage 開始：${gs.chapter}-${gs.stage} / ${gs.floor}F${gs.isNight?' 🌙':''}`, 'dim');
}

function startStageHead() {
  gs.isNight = (gs.stage === 10);
  setupStageCounters();
  // 章頭でHP回復
  playerHp = playerHpMax;
  updatePlayerHpUI();
}

function nextStage() {
  addLog(`✅ クリア：${gs.chapter}-${gs.stage} / ${gs.floor}F`, 'gain');

  gs.stage += 1;
  if (gs.stage > 10) {
    gs.stage = 1;
    gs.isNight = false;
    gs.chapter += 1;
    if (gs.chapter > 30) {
      gs.chapter = 1;
      gs.floor += 1;
      gs.hpScale = +(gs.hpScale * 1.5).toFixed(6);
      addLog(`🔺 階層UP！ いま ${gs.floor}F（HP係数×${gs.hpScale.toFixed(2)}）`, 'gain');
    }
  }
  clearAllEnemies();
  startStageHead();
  saveGame();
}

function failStage() {
  clearAllEnemies();
  gs.stage = 1;
  gs.isNight = false;
  spawnTimer = 0;
  baseSpawnDelay = 800;
  setupStageCounters();
  addLog(`↩︎ リトライ：${gs.chapter}-1 / ${gs.floor}F から`, 'alert');
  gs.paused = false;
  gs.running = true;
  startStageHead();
  saveGame();
}

function clearAllEnemies() {
  for (let i = enemies.length - 1; i >= 0; i--) {
    releaseEnemyEl(enemies[i].el);
    enemies.splice(i, 1);
  }
  spawnPlan.alive = 0;
}

/* (15) ---------- スタート画面 & 一時停止/再開/リトライ ---------- */
function showStartScreen() {
  if (hasSave()) {
    btnContinue && (btnContinue.disabled = false);
    if (continueHintEl) continueHintEl.textContent = '前回の続きから再開できます。';
  } else {
    btnContinue && (btnContinue.disabled = true);
    if (continueHintEl) continueHintEl.textContent = 'セーブデータがあれば「つづきから」が有効になります。';
  }
  startScreenEl?.setAttribute('aria-hidden', 'false');
  gs.running = false;
}
function hideStartScreen() {
  startScreenEl?.setAttribute('aria-hidden', 'true');
  gs.running = true;
  gs.paused = false;
  measureRects();
  startStageHead();
}

// はじめから/つづきから
btnNew?.addEventListener('click', () => {
  gold = 0; diamonds = 0; refreshCurrencies();
  gs.floor = 1; gs.chapter = 1; gs.stage = 1; gs.isNight = false; gs.hpScale = 1.0;
  playerHpMax = 100; playerHp = playerHpMax; updatePlayerHpUI();
  lightning.baseDmg = 8; lightning.cooldown = 0.70; lightning.range = 380; lightning.chainCount = 2;
  saveGame();
  hideStartScreen();
});
btnContinue?.addEventListener('click', () => {
  const data = loadGame();
  if (data) {
    gold = data.gold ?? gold;
    diamonds = data.diamonds ?? 0;
    refreshCurrencies();
    gs.floor = data.floor ?? 1;
    gs.chapter = data.chapter ?? 1;
    gs.stage = data.stage ?? 1;
    gs.isNight = !!data.isNight;
    gs.hpScale = data.hpScale ?? 1.0;
    playerHpMax = data.playerHpMax ?? 100;
    playerHp    = data.playerHp ?? playerHpMax;
    updatePlayerHpUI();
    if (data.lightning) {
      lightning.baseDmg = data.lightning.baseDmg ?? lightning.baseDmg;
      lightning.cooldown= data.lightning.cooldown ?? lightning.cooldown;
      lightning.range   = data.lightning.range ?? lightning.range;
      lightning.chainCount = data.lightning.chainCount ?? lightning.chainCount;
      chainEl.textContent = `${lightning.chainCount}/15`;
    }
  }
  hideStartScreen();
});

// 一時停止/再開/リトライ（存在すれば動かす）
btnPause?.addEventListener('click', () => { if (!gs.running) return; gs.paused = true;  addLog('⏸ 一時停止', 'dim'); });
btnResume?.addEventListener('click',()=> { if (!gs.running) return; gs.paused = false; addLog('▶ 再開',   'dim'); });
btnRetry?.addEventListener('click', () => { if (!gs.running) return; addLog('↻ リトライ（章の頭へ）', 'alert'); failStage(); });

// オートセーブ
setInterval(() => { if (gs.running && !gs.paused) saveGame(); }, 5000);

/* (16) ---------- GameAPI 公開（upgrades.js から使う） ---------- */
const listeners = { stageChange: new Set() };
function emitStageChange(){ listeners.stageChange.forEach(fn=>{ try{ fn(getStageInfo()); }catch{} }); }

function getStageInfo(){ return { floor:gs.floor, chapter:gs.chapter, stage:gs.stage, isNight:gs.isNight }; }

window.GameAPI = {
  // 通貨
  getGold: ()=>gold,
  addGold: (v)=>{ gold+=v; refreshCurrencies(); saveGame(); },
  spendGold: (v)=>{ if (gold>=v){ gold-=v; refreshCurrencies(); saveGame(); return true;} return false; },
  getDiamonds: ()=>diamonds,
  addDiamonds: (v)=>{ diamonds+=v; refreshCurrencies(); saveGame(); },

  // 雷パラメータ
  lightning,
  setBaseDmg: (v)=>{ lightning.baseDmg = Math.max(1, v); saveGame(); },
  setCooldown: (v)=>{ lightning.cooldown = Math.max(0.2, v); saveGame(); },
  setRange: (v)=>{ lightning.range = Math.max(60, v); saveGame(); },
  setChain: (v)=>{ lightning.chainCount = Math.max(0, Math.min(14, v)); chainEl.textContent = `${lightning.chainCount}/15`; saveGame(); },

  // プレイヤー
  getPlayerHp: ()=>({ hp:playerHp, max:playerHpMax }),
  healPlayer: (v)=>{ playerHp=Math.min(playerHpMax, playerHp+v); updatePlayerHpUI(); saveGame(); },
  setPlayerHpMax: (m)=>{ playerHpMax=Math.max(1,m); playerHp=Math.min(playerHp,playerHpMax); updatePlayerHpUI(); saveGame(); },

  // ステージ情報
  getStageInfo,
  onStageChange: (fn)=>{ listeners.stageChange.add(fn); },
  offStageChange:(fn)=>{ listeners.stageChange.delete(fn); },

  // ログ
  addLog,
};

// ステージ遷移時に通知
const _nextStage = nextStage;
nextStage = function(){ _nextStage(); emitStageChange(); };
const _failStage = failStage;
failStage = function(){ _failStage(); emitStageChange(); };

/* (17) ---------- 初期化 ---------- */
function init() {
  measureRects();
  addLog('タイトル待機中：「はじめから／つづきから」を選んでください', 'dim');
  last = performance.now();
  requestAnimationFrame(gameLoop);
}
window.addEventListener('load', () => {
  init();
  showStartScreen();
});