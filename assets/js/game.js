/* =========================================================
   Idle Lightning - game.js (EnemyDB連携) v6.3-stable
   主要ポイント:
   - 「はじめから」で全データ初期化（Exp/Status/装備も可能な限り）
   - 失敗→何度でも復帰: Retry常時有効 / ウォッチドッグ再セット
   - 近接AI安定化: windup/strike/recoilは停止＆recoil終端でスナップ
   - 押し込みはプレイヤーから離す方向
   - ログ右上にBGMトグル（永続化）
   - startStageHead() 先に盤面クリア→新規セット（敵HP残像防止）
   ========================================================= */

/* ========== (1) ヒット/押し込み ========== */
const HIT_SCALE_SPIRIT = 0.42;
const HIT_SCALE_ENEMY  = 0.40;
const HIT_MARGIN       = 2;
const ENGAGE_EXTRA     = 6;
const PUSH_STRENGTH    = 0.10;

/* ========== (2) DOM ========== */
const laneEl   = document.getElementById('enemy-lane');
const logEl    = document.getElementById('log');
const goldEl   = document.getElementById('gold');
const diaEl    = document.getElementById('diamond');
const dpsEl    = document.getElementById('dps');
const chainEl  = document.getElementById('chain');
const stageLabelEl = document.getElementById('stageLabel');
const remainEl = document.getElementById('remain');
const spiritEl = document.querySelector('.spirit');

const playerHpBarEl   = document.getElementById('player-hp');
const playerHpFillEl  = playerHpBarEl?.querySelector('.fill');
const playerHpLabelEl = document.getElementById('playerHpLabel');

/* ========== (3) スタート/メニュー ========== */
const startScreenEl  = document.getElementById('start-screen');
const btnNew         = document.getElementById('btn-new');
const btnContinue    = document.getElementById('btn-continue');
const continueHintEl = document.getElementById('continue-hint');
const btnPause  = document.getElementById('btn-pause');
const btnResume = document.getElementById('btn-resume');
const btnRetry  = document.getElementById('btn-retry');
const btnStatus = document.getElementById('btn-status');

/* ========== (4) レイアウト ========== */
let laneRect;
function measureRects(){
  if (!laneEl) return;
  laneRect = laneEl.getBoundingClientRect();
}
window.addEventListener('resize', measureRects);
window.addEventListener('orientationchange', () => setTimeout(measureRects, 200));

/* ========== (5) ログ ========== */
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

/* ========== (6) セーブ/ロード ========== */
const SAVE_KEY = 'idleLightningSaveV63';
function saveGame() {
  const data = {
    ts: Date.now(),
    gold, diamonds,
    floor: gs.floor, chapter: gs.chapter, stage: gs.stage, isNight: gs.isNight,
    hpScale: gs.hpScale,
    playerHp, playerHpMax,
    lightning: {
      baseDmg: lightning.baseDmg,
      cooldown: lightning.cooldown,
      range: lightning.range,
      chainCount: lightning.chainCount
    }
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch {}
}
function loadGame() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function hasSave() { return !!localStorage.getItem(SAVE_KEY); }

/* ========== (7) ステート & ウォッチドッグ ========== */
const gs = {
  floor: 1,
  chapter: 1,
  stage: 1,
  isNight: false,
  hpScale: 1.0,
  paused: false,
  running: false
};
const watchdog = {
  lastProgress: performance.now(),
  lastFailAt: 0,
  lastStageStartAt: 0
};
function touchProgress(){ watchdog.lastProgress = performance.now(); }

/* ========== (8) 通貨/HP/UI ========== */
let gold = 0;
let diamonds = 0;
let dpsSmoothed = 0;

function refreshCurrencies(){
  if (goldEl) goldEl.textContent = gold;
  if (diaEl)  diaEl.textContent  = diamonds;
  if (dpsEl)  dpsEl.textContent  = Math.round(dpsSmoothed);
  mountStatusGoldPill();
}
refreshCurrencies();

let playerHpMax = 100;
let playerHp    = playerHpMax;
function updatePlayerHpUI(){
  const ratio = Math.max(0, Math.min(1, playerHp / playerHpMax));
  if (playerHpFillEl) playerHpFillEl.style.width = (ratio * 100).toFixed(1) + '%';
  if (playerHpLabelEl) playerHpLabelEl.textContent = `${Math.max(0,Math.ceil(playerHp))}/${playerHpMax}`;
}
updatePlayerHpUI();

/* ========== (9) 進行UI ========== */
function updateStageLabel() {
  if (stageLabelEl) stageLabelEl.textContent = `${gs.chapter}-${gs.stage} / ${gs.floor}F${gs.isNight ? ' 🌙' : ''}`;
}
function updateRemainLabel() {
  if (!remainEl) return;
  const left = Math.max(0, spawnPlan.total - spawnPlan.spawned) + spawnPlan.alive;
  remainEl.textContent = String(left);
}
updateStageLabel();

/* ========== (10) 雷 ========== */
const lightning = {
  baseDmg: 8,
  cooldown: 0.70,
  cooldownBase: undefined,
  range: 380,
  baseRange: undefined,
  chainCount: 2,
  falloff: 0.85,
  timer: 0
};
chainEl && (chainEl.textContent = `${lightning.chainCount}/15`);

/* ========== (11) EnemyDB 参照（フォールバック） ========== */
const DB = (function(){
  const F = window.EnemyDB || {};
  const defs = F.defs || {
    swarm: { name:'Swarm', icon:'🦂', size:28, speed:120, hp:20, dmg:8, reward:1,
      atk:{ range:26, windup:0.50, active:0.20, lunge:12, rate:0.9, recoil:0.18 } },
    runner:{ name:'Runner',icon:'🦅', size:26, speed:170, hp:14, dmg:10, reward:1,
      atk:{ range:24, windup:0.40, active:0.18, lunge:14, rate:1.1, recoil:0.15 } },
    tank:  { name:'Tank',  icon:'🦏', size:34, speed:90,  hp:90, dmg:20, reward:5,
      atk:{ range:30, windup:0.70, active:0.25, lunge:10, rate:0.60, recoil:0.30 } },
  };
  const weights = F.weights || (() => ([
    { type:'swarm',  w:0.60 },
    { type:'runner', w:0.25 },
    { type:'tank',   w:0.15 },
  ]));
  const chapterHpMul = F.chapterHpMul || (chapter => 1 + (chapter-1)*0.15);
  const nightHpMul   = F.nightHpMul   || (isNight => isNight? 1.8 : 1.0);
  return { defs, weights, chapterHpMul, nightHpMul };
})();

/* ========== (12) 敵プール ========== */
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
function resetEnemyEl(el){
  el.className = 'enemy';
  el.style.cssText = '';
  el.dataset.eid = '';
  el.dataset.alive = '';
  let iconEl = el.querySelector('.icon');
  let hpEl   = el.querySelector('.hp');
  if (!iconEl) { iconEl = document.createElement('span'); iconEl.className='icon'; el.prepend(iconEl); }
  if (!hpEl)   { hpEl   = document.createElement('div');   hpEl.className='hp';  el.append(hpEl); }
  hpEl.style.width = '100%';
  el.setAttribute('data-hp', '');
}

/* ========== (13) ステージ/スポーン ========== */
function stageTotalCount(chapter, stage) {
  const base = 8 + (stage - 1);
  return (stage === 10) ? Math.round(base * 2) : base;
}
function hpMultiplier() {
  return gs.hpScale * DB.chapterHpMul(gs.chapter) * DB.nightHpMul(gs.isNight);
}
const MAX_CONCURRENT = 40;
const NIGHT_DIAMOND_RATE = 0.10;

let spawnPlan = { total: 0, spawned: 0, alive: 0 };
let spawnTimer = 0;
let baseSpawnDelay = 1000;
let burstLeft = 0;

function setupStageCounters() {
  spawnPlan.total   = stageTotalCount(gs.chapter, gs.stage);
  spawnPlan.spawned = 0;
  spawnPlan.alive   = 0;
  spawnTimer = 0;
  burstLeft = Math.min(3, spawnPlan.total);
  baseSpawnDelay = Math.max(450, 800 - gs.stage*25);
  updateStageLabel();
  updateRemainLabel();
  addLog(`Stage 開始：${gs.chapter}-${gs.stage} / ${gs.floor}F${gs.isNight?' 🌙':''}`, 'dim');
  watchdog.lastStageStartAt = performance.now();
  touchProgress();
}

function pickEnemyType() {
  const weights = DB.weights(gs.chapter, gs.stage);
  const r = Math.random(); let acc = 0;
  for (const x of weights) { acc += x.w; if (r <= acc) return x.type; }
  return weights[0].type;
}

let laneWidthCached = 0, laneHeightCached = 0;
let enemySeq = 1;
const enemies = [];

function spawnEnemy(type = pickEnemyType()) {
  if (!laneRect || laneRect.width === 0) measureRects();
  laneWidthCached  = laneRect.width;
  laneHeightCached = laneRect.height;

  const def = DB.defs[type] || DB.defs.swarm;
  const el = getEnemyEl();
  resetEnemyEl(el);

  const eid = enemySeq++;
  el.dataset.eid = String(eid);
  el.dataset.alive = "1";
  laneEl.appendChild(el);

  el.querySelector('.icon').textContent = def.icon || '👾';

  const startX = laneWidthCached - 60 - Math.random() * 40;
  const startY = Math.max(16, Math.min(laneHeightCached - 16, laneHeightCached * (0.10 + 0.80 * Math.random())));

  const hpMax = Math.max(1, Math.round(def.hp * hpMultiplier()));

  el.style.transform = `translate(${startX}px, ${startY}px)`;
  el.querySelector('.hp').style.width = '100%';
  el.setAttribute('data-hp', hpMax);

  enemies.push({
    eid, el, def,
    x: startX, y: startY,
    vx: 0, vy: 0,
    speed: def.speed,
    hp: hpMax, maxHp: hpMax,
    reward: def.reward, dmg: def.dmg,
    t: 0,
    swayAmp: 6 + Math.random()*10,
    swayFreq: 1.0 + Math.random()*0.8,
    state: 'chase', // 'chase' | 'windup' | 'strike' | 'recoil'
    st: 0,
    atkCool: 0,
    strikeFromX: 0, strikeFromY: 0,
    strikeToX: 0,   strikeToY: 0,
    strikeHitDone: false,
    recoilFromX: 0, recoilFromY: 0,
    recoilToX: 0,   recoilToY: 0,
  });

  spawnPlan.spawned++;
  spawnPlan.alive++;
  updateRemainLabel();
  touchProgress();
}

function trySpawn(dt) {
  if (spawnPlan.spawned >= spawnPlan.total) return;
  if (spawnPlan.alive   >= MAX_CONCURRENT) return;

  if (burstLeft > 0) { spawnEnemy(); burstLeft--; return; }

  spawnTimer += dt * 1000;
  const dynamicDelay = baseSpawnDelay + Math.max(0, (spawnPlan.alive - 12) * 12);
  if (spawnTimer >= dynamicDelay) { spawnTimer = 0; spawnEnemy(); }
}

/* ========== (14) ビーム演出 ========== */
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

/* ========== (15) ヘルパ ========== */
function centerScreen(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

/* ========== (16) EXP フォールバック ========== */
const ExpAPI = {
  expFromKill(gs, type){
    if (window.Exp?.expFromKill) return window.Exp.expFromKill(gs, type);
    const base = {swarm:1, runner:2, tank:6}[type]||1;
    const chap = 1 + (gs.chapter-1)*0.25;
    const night= gs.isNight?1.5:1;
    return Math.round(base*chap*night);
  },
  expFromStageClear(gs){
    if (window.Exp?.expFromStageClear) return window.Exp.expFromStageClear(gs);
    return 10 + (gs.chapter-1)*5 + (gs.stage===10?15:0);
  },
  addExp(v, why){
    if (window.Exp?.addExp) window.Exp.addExp(v, why);
    else addLog(`+${v} EXP (${why})`, 'gain');
  }
};

/* ========== (17) 敵削除 ========== */
function removeEnemyById(eid, {by='unknown', fade=false} = {}) {
  const idx = enemies.findIndex(o => o.eid === eid);
  if (idx === -1) return;
  const e = enemies[idx];
  enemies.splice(idx, 1);
  spawnPlan.alive = Math.max(0, spawnPlan.alive - 1);
  updateRemainLabel();
  touchProgress();

  if (fade) {
    const keepEid = String(eid);
    e.el.classList.add('dead');
    setTimeout(() => {
      if (e.el.dataset.eid === keepEid && e.el.dataset.alive === "1") {
        e.el.dataset.alive = "0";
        releaseEnemyEl(e.el);
      }
    }, 220);
  } else {
    e.el.dataset.alive = "0";
    releaseEnemyEl(e.el);
  }
}

/* ========== (18) プレイヤー被ダメ ========== */
function damagePlayer(amount){
  playerHp = Math.max(0, playerHp - (Number.isFinite(amount) ? amount : 0));
  updatePlayerHpUI();
  if (playerHp <= 0) {
    addLog('💥 HPが0になった…章の初めからリトライ！', 'alert');
    failStage();
  }
}

/* ========== (19) 落雷攻撃 ========== */
function tryAttack(dt) {
  lightning.timer -= dt;
  if (lightning.timer > 0) return;

  const sc = centerScreen(spiritEl);
  const sx = sc.x - laneRect.left;
  const sy = sc.y - laneRect.top;

  const r2 = lightning.range * lightning.range;

  const cand = [];
  for (const e of enemies) {
    const ec = centerScreen(e.el);
    const ex = ec.x - laneRect.left;
    const ey = ec.y - laneRect.top;
    const d2 = dist2(sx, sy, ex, ey);
    if (d2 <= r2) cand.push({ e, d2, ex, ey });
  }
  if (!cand.length) { lightning.timer = Math.max(0.05, lightning.cooldown*0.3); return; }

  cand.sort((a,b)=>a.d2-b.d2);
  const maxHits = Math.min(lightning.chainCount + 1, cand.length);

  const used = new Set();
  let dmg = lightning.baseDmg;
  let dealtTotal = 0;

  const first = cand[0];
  spawnBeam(sx, sy, first.ex, first.ey);
  used.add(first.e.eid);

  let prevX = first.ex, prevY = first.ey;

  for (let i = 0; i < maxHits; i++) {
    const pick = (i === 0) ? first : cand.find(o => !used.has(o.e.eid));
    if (!pick) break;

    if (i > 0) spawnBeam(prevX, prevY, pick.ex, pick.ey);

    let mul = 1;
    if (window.Status && Math.random() < window.Status.getCritChance()) {
      mul = window.Status.getCritMul();
    }

    pick.e.hp -= dmg * mul;
    dealtTotal += Math.max(0, dmg * mul);

    const ratio = Math.max(0, pick.e.hp / pick.e.maxHp);
    const bar = pick.e.el.querySelector('.hp');
    if (bar) bar.style.width = (ratio * 100).toFixed(1) + '%';
    pick.e.el.setAttribute('data-hp', Math.max(0, Math.round(pick.e.hp)));

    pick.e.el.classList.add('hit');
    setTimeout(()=>pick.e.el.classList.remove('hit'), 80);

    used.add(pick.e.eid);
    prevX = pick.ex; prevY = pick.ey;
    dmg *= lightning.falloff;
  }

  // 撃破処理
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.hp <= 0) {
      if (gs.isNight && Math.random() < NIGHT_DIAMOND_RATE) {
        diamonds++; diaEl && (diaEl.textContent = diamonds);
        addLog('💎 ダイヤを獲得！', 'gain');
      }
      const gMul = window.Status ? window.Status.getGoldMul() : 1;
      const gainG = Math.max(1, Math.round((e.reward||1) * gMul));
      gold += gainG; goldEl && (goldEl.textContent = gold);

      const expGain = ExpAPI.expFromKill(gs, e.def && e.def.name ? e.def.name.toLowerCase() : 'swarm');
      ExpAPI.addExp(expGain, 'kill');
      addLog(`+${expGain} EXP (kill)`, 'gain');

      removeEnemyById(e.eid, { by:'beam', fade:true });
    }
  }

  logAttack(used.size, dealtTotal);
  lightning.timer = lightning.cooldown;
  touchProgress();
}

/* ========== (20) ゲームループ/AI ========== */
let last;
function getSpiritCenter(){ return centerScreen(spiritEl); }
function getEnemyCenter(e){ return centerScreen(e.el); }

function enemyRadius(e){
  const size = (e.def?.size) || 28;
  return Math.max(10, size * HIT_SCALE_ENEMY);
}
function spiritRadius(){
  const sr = spiritEl.getBoundingClientRect();
  return Math.max(sr.width, sr.height) * HIT_SCALE_SPIRIT || 16;
}

function gameLoop(now = performance.now()) {
  let dt = (now - last) / 1000; last = now;
  if (!Number.isFinite(dt) || dt <= 0) dt = 0.016;
  dt = Math.min(dt, 0.033);

  if (!gs.running || gs.paused) { requestAnimationFrame(gameLoop); return; }

  if (!laneRect) {
    measureRects();
  } else {
    const r = laneEl.getBoundingClientRect();
    if (Math.abs(r.top - laneRect.top) > 1 ||
        Math.abs(r.height - laneRect.height) > 1 ||
        Math.abs(r.left - laneRect.left) > 1) {
      laneRect = r;
    }
  }

  const scScr = getSpiritCenter();
  let sxLane = Math.max(0, Math.min(laneRect.width,  scScr.x - laneRect.left));
  let syLane = Math.max(0, Math.min(laneRect.height, scScr.y - laneRect.top));

  const rS = spiritRadius();

  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    e.t += dt;
    e.st += dt;

    if (e.atkCool > 0) e.atkCool -= dt;

    let dx = sxLane - e.x, dy = syLane - e.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist, ny = dy / dist;

    const A  = e.def.atk;
    const rE = enemyRadius(e);
    const rr = rS + rE + HIT_MARGIN;
    const inMelee = dist <= Math.max(rr, A.range);

    if (e.state === 'chase') {
      const desiredVx = nx * e.speed;
      const desiredVy = ny * e.speed;
      const steer = 0.5;
      e.vx += (desiredVx - e.vx) * steer;
      e.vy += (desiredVy - e.vy) * steer;

      const sway = Math.sin(e.t * (2 * Math.PI * e.swayFreq)) * e.swayAmp;
      e.x += e.vx * dt;
      e.y += (e.vy + sway * 0.8) * dt;

      // プレイヤーから離す方向に押し込み
      if (dist < (rr + ENGAGE_EXTRA)) {
        e.x -= nx * (rr + ENGAGE_EXTRA - dist) * PUSH_STRENGTH;
        e.y -= ny * (rr + ENGAGE_EXTRA - dist) * PUSH_STRENGTH;
      }

      if (inMelee && e.atkCool <= 0) {
        e.state = 'windup';
        e.st = 0;
        e.vx = e.vy = 0;
        e.el.classList.add('pose-windup');
      }
    }
    else if (e.state === 'windup') {
      e.vx = e.vy = 0;
      if (e.st >= A.windup) {
        e.strikeFromX = e.x;
        e.strikeFromY = e.y;
        e.strikeToX   = e.x - A.lunge;
        e.strikeToY   = e.y;

        e.strikeHitDone = false;
        e.state = 'strike';
        e.st = 0;
        e.el.classList.remove('pose-windup');
        e.el.classList.add('pose-strike');
      }
    }
    else if (e.state === 'strike') {
      e.vx = e.vy = 0;
      const t = Math.min(1, e.st / A.active);
      e.x = e.strikeFromX + (e.strikeToX - e.strikeFromX) * t;
      e.y = e.strikeFromY + (e.strikeToY - e.strikeFromY) * t;

      if (!e.strikeHitDone && e.st >= A.active) {
        e.strikeHitDone = true;
        const hitDmg = Number.isFinite(e.dmg) ? e.dmg : (Number.isFinite(e.def?.dmg) ? e.def.dmg : 5);
        addLog(`⚡ 攻撃ヒット：${e.def.name}（-${hitDmg} HP）`, 'alert');
        damagePlayer(hitDmg);

        e.recoilFromX = e.x;
        e.recoilFromY = e.y;
        e.recoilToX   = e.strikeFromX;
        e.recoilToY   = e.strikeFromY;

        e.state = 'recoil';
        e.st = 0;
        e.atkCool = A.rate;
        e.el.classList.remove('pose-strike');
        e.el.classList.add('pose-recoil');
      }
    }
    else if (e.state === 'recoil') {
      e.vx = e.vy = 0;
      const t = Math.min(1, e.st / A.recoil);
      const rx = e.recoilFromX + (e.recoilToX - e.recoilFromX) * t;
      const ry = e.recoilFromY + (e.recoilToY - e.recoilFromY) * t;
      e.x = rx;
      e.y = ry;

      if (e.st >= A.recoil) {
        e.x = e.recoilToX;
        e.y = e.recoilToY;
        e.vx = 0; e.vy = 0;
        e.state = 'chase';
        e.st = 0;
        e.el.classList.remove('pose-recoil');
      }
    }

    e.el.style.transform = `translate(${e.x}px, ${e.y}px)`;

    const ec = getEnemyCenter(e);
    const br = laneRect;
    const marginX = 160, marginY = 200;
    if (ec.x < br.left - marginX || ec.x > br.right + marginX ||
        ec.y < br.top  - marginY || ec.y > br.bottom + marginY) {
      const escDmg = Math.ceil((Number.isFinite(e.dmg) ? e.dmg : 5) * 0.5);
      addLog(`突破（escape）：${e.def.name}（-${escDmg} HP）`, 'alert');
      damagePlayer(escDmg);
      removeEnemyById(e.eid, { by:'escape', fade:false });
      continue;
    }
  }

  tryAttack(dt);
  trySpawn(dt);

  if (spawnPlan.spawned >= spawnPlan.total && spawnPlan.alive <= 0 && enemies.length === 0) {
    nextStage();
  }

  // ウォッチドッグ: 失敗直後や開始直後に停滞したら再セット
  const nowMs = performance.now();
  if (gs.running && !gs.paused) {
    const noEnemy = enemies.length === 0 && spawnPlan.alive === 0;
    const notSpawning = spawnPlan.spawned === 0 && spawnPlan.total > 0;
    const sinceStart = nowMs - watchdog.lastStageStartAt;
    const sinceFail  = nowMs - watchdog.lastFailAt;
    const sinceProg  = nowMs - watchdog.lastProgress;

    if (noEnemy && notSpawning && sinceStart > 1200 && sinceFail > 800 && sinceProg > 2500) {
      addLog('🛠 再起動ガード: ステージを再セット', 'dim');
      startStageHead();
      touchProgress();
    }
  }

  requestAnimationFrame(gameLoop);
}

/* ========== (21) ステージ遷移 ========== */
function startStageHead() {
  // 盤面を空に（敵HP残像防止）
  clearAllEnemies();
  enemySeq = 1;

  gs.isNight = (gs.stage === 10);
  setupStageCounters();
  playerHp = playerHpMax;
  updatePlayerHpUI();
  measureRects();

  // BGM反映
  applyBgmForStage();
}

function nextStage() {
  addLog(`✅ クリア：${gs.chapter}-${gs.stage} / ${gs.floor}F`, 'gain');

  const clearExp = ExpAPI.expFromStageClear(gs);
  ExpAPI.addExp(clearExp, 'clear');
  addLog(`+${clearExp} EXP (clear)`, 'gain');

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
  emitStageChange();
}

function failStage() {
  clearAllEnemies();
  // 章は維持、ステージを1へ（要件通り: 1-8敗北→1-1、2-7敗北→2-1）
  gs.stage = 1;
  gs.isNight = false;

  // 再スポーンの各種初期化
  spawnTimer = 0;
  baseSpawnDelay = 1000;
  setupStageCounters();

  addLog(`↩︎ リトライ：${gs.chapter}-1 / ${gs.floor}F から`, 'alert');

  gs.paused = false;
  gs.running = true;

  // 大きいdt防止
  last = performance.now();

  startStageHead();
  saveGame();

  watchdog.lastFailAt = performance.now();
  emitStageChange();
}

function clearAllEnemies() {
  while (enemies.length) {
    const { eid } = enemies[enemies.length - 1];
    removeEnemyById(eid, { by:'clear', fade:false });
  }
}

/* ========== (21.9) NewGame: 全初期化 ========== */
function resetAllProgressHard(){
  try { localStorage.removeItem(SAVE_KEY); } catch {}

  gold = 0; diamonds = 0; dpsSmoothed = 0;
  gs.floor = 1; gs.chapter = 1; gs.stage = 1; gs.isNight = false; gs.hpScale = 1.0;
  playerHpMax = 100; playerHp = playerHpMax; updatePlayerHpUI();
  lightning.baseDmg = 8; lightning.cooldown = 0.70; lightning.range = 380; lightning.chainCount = 2;

  clearAllEnemies();
  enemySeq = 1;
  updateRemainLabel();

  // 外部モジュールの初期化（あれば）
  try { window.Exp?.reset?.(); } catch {}
  try { window.Status?.reset?.(); } catch {}

  // フォールバック: よく使うキー接頭辞をパージ（必要に応じて増やしてください）
  try {
    const toZapPrefixes = ['idleLightning', 'il:', 'exp', 'status', 'gear'];
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (toZapPrefixes.some(p => k.startsWith(p))) localStorage.removeItem(k);
    }
  } catch {}

  refreshCurrencies();
  updateStageLabel();
}

/* ========== (22) Start/Continue/一時停止 ========== */
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

btnNew?.addEventListener('click', () => {
  resetAllProgressHard();
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
      lightning.baseDmg   = data.lightning.baseDmg   ?? lightning.baseDmg;
      lightning.cooldown  = data.lightning.cooldown  ?? lightning.cooldown;
      lightning.range     = data.lightning.range     ?? lightning.range;
      lightning.chainCount= data.lightning.chainCount?? lightning.chainCount;
      chainEl && (chainEl.textContent = `${lightning.chainCount}/15`);
    }
  }
  hideStartScreen();
});

btnPause?.addEventListener('click', () => { gs.paused = true;  addLog('⏸ 一時停止', 'dim'); });
btnResume?.addEventListener('click',()=> { gs.paused = false; addLog('▶ 再開',   'dim'); });
// Retry は常に動作
btnRetry?.addEventListener('click', () => {
  addLog('↻ リトライ（章の頭へ）', 'alert');
  failStage();
});

// オートセーブ
setInterval(() => { if (gs.running && !gs.paused) saveGame(); }, 5000);

/* ========== (23) GameAPI ========== */
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

  // 雷
  lightning,
  setBaseDmg: (v)=>{ lightning.baseDmg = Math.max(1, v); saveGame(); },
  setCooldown: (v)=>{ lightning.cooldown = Math.max(0.15, v); saveGame(); },
  setRange: (v)=>{ lightning.range = Math.max(60, v); saveGame(); },
  setChain: (v)=>{ lightning.chainCount = Math.max(0, Math.min(14, v)); chainEl && (chainEl.textContent = `${lightning.chainCount}/15`); saveGame(); },

  // プレイヤー
  getPlayerHp: ()=>({ hp:playerHp, max:playerHpMax }),
  healPlayer: (v)=>{ playerHp=Math.min(playerHpMax, playerHp+v); updatePlayerHpUI(); saveGame(); },
  setPlayerHpMax: (m)=>{ playerHpMax=Math.max(1,m); playerHp=Math.min(playerHp,playerHpMax); updatePlayerHpUI(); saveGame(); },

  // ステージ
  getStageInfo,
  onStageChange: (fn)=>{ listeners.stageChange.add(fn); },
  offStageChange:(fn)=>{ listeners.stageChange.delete(fn); },

  // 便宜
  addLog,
  updateRemainLabel,
};

/* ========== (24) 初期化 ========== */
function init() {
  measureRects();
  addLog('タイトル待機中：「はじめから／つづきから」を選んでください', 'dim');
  last = performance.now();
  requestAnimationFrame(gameLoop);
}
window.addEventListener('load', () => {
  init();
  showStartScreen();

  // Status 初期化（lightning の基準値退避＆反映）
  setTimeout(()=> {
    if (window.Status && window.GameAPI){
      if (lightning.cooldownBase==null) lightning.cooldownBase = lightning.cooldown;
      if (lightning.baseRange==null)    lightning.baseRange    = lightning.range;
      window.Status.init(window.GameAPI);
      mountStatusGoldPill();
    }
  }, 0);

  btnStatus?.addEventListener('click', ()=>{
    if (window.Status && window.GameAPI) window.Status.open(window.GameAPI);
    setTimeout(mountStatusGoldPill, 0);
  });

  // BGMボタン（ON/OFF）
  wireBgmToggleButton();
});

/* ========== (25) ユーティリティ: テキスト一致 ========== */
function queryByText(root, tagSelector, contains){
  const els = root.querySelectorAll(tagSelector);
  for (const el of els) {
    if ((el.textContent||'').trim().includes(contains)) return el;
  }
  return null;
}

/* ========== (26) ステータス見出しにゴールドピル ========== */
function mountStatusGoldPill(){
  try{
    const root = document.querySelector('[data-status-root], .status, .status-modal, #status') || document.body;
    if (!root) return;
    const title = queryByText(root, 'h1, h2, .title, [data-title]', 'ステータス強化');
    if (!title) return;
    let pill = title.querySelector('.gold-pill');
    if (!pill){
      pill = document.createElement('span');
      pill.className = 'gold-pill';
      pill.style.cssText = `
        margin-left:.5rem; padding:.1rem .45rem; border:1px solid rgba(255,215,0,.7);
        border-radius:999px; font-size:.85em; white-space:nowrap;
        background:rgba(255,215,0,.08); vertical-align:baseline; display:inline-block;
      `;
      title.appendChild(pill);
    }
    pill.textContent = `💰 ${gold.toLocaleString()}`;
  }catch{}
}

/* ========== (27) BGM 管理 ========== */
const BGM_KEY = 'bgmEnabled';
function bgmEnabled(){ const v = localStorage.getItem(BGM_KEY); return v == null ? true : v === '1'; }
function setBgmEnabled(on){ try { localStorage.setItem(BGM_KEY, on ? '1' : '0'); } catch {} }

function ensureBgmInit(){
  const day = document.getElementById('bgm-day');
  const night = document.getElementById('bgm-night');
  if (!day || !night) return;
  day.volume = 0.7;
  night.volume = 0.7;
}

async function applyBgmForStage(){
  ensureBgmInit();
  const day = document.getElementById('bgm-day');
  const night = document.getElementById('bgm-night');
  if (!day || !night) return;

  if (bgmEnabled()) {
    if (gs.isNight) { try{ day.pause(); await night.play(); }catch{} }
    else            { try{ night.pause(); await day.play(); }catch{} }
  } else {
    try{ day.pause(); night.pause(); }catch{}
  }

  // ボタンの表示更新
  const btn = document.getElementById('btn-bgm');
  if (btn){
    btn.setAttribute('aria-pressed', String(bgmEnabled()));
    btn.textContent = bgmEnabled() ? '♪ BGM ON' : '♪ BGM OFF';
  }
}

function wireBgmToggleButton(){
  const btn = document.getElementById('btn-bgm');
  if (!btn) return;
  const syncBtn = () => {
    btn.setAttribute('aria-pressed', String(bgmEnabled()));
    btn.textContent = bgmEnabled() ? '♪ BGM ON' : '♪ BGM OFF';
  };
  syncBtn();
  btn.addEventListener('click', async () => {
    setBgmEnabled(!bgmEnabled());
    await applyBgmForStage();
  });
  // ステージ変化でBGMも切り替え
  window.GameAPI?.onStageChange?.(applyBgmForStage);
}