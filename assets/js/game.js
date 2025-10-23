/* =========================================================
   Idle Lightning - game.js (EnemyDB連携) v6.4-ext-audiofix
   - Startロック & 二重init防止
   - BGMトグル安定化＋自己復帰＋初回ジェスチャーで“音解禁”
   - 「はじめから」で Status/EXP も完全リセット（idleLightning*掃除）
   - ウォッチドッグ強化
   - 敵は常に画面右の外でスポーン＋スポーングレース
   - CLEAR! 表示後に遷移
   - 攻撃SFX（attack.mp3）をビーム発射に同期（BGMトグルに追従）
   ========================================================= */

/* ========== Config ========== */
const ENEMY_SPEED_MUL = 0.88;
const CLEAR_PAUSE_MS  = 3000;

// 右側オフスクリーンスポーン距離＆脱落判定の余白
const SPAWN_OFF_X     = 260;
const ESCAPE_MARGIN_X = SPAWN_OFF_X + 260;
const ESCAPE_MARGIN_Y = 320;

// スポーン直後の「脱落判定をしない猶予」(秒)
const SPAWN_GRACE_SEC = 0.9;

// SFX
const ATTACK_SFX_VOL  = 0.28;
const ATTACK_SFX_POLY = 4;
const SFX_FOLLOWS_BGM = true; // falseにするとBGM OFFでもSFXは鳴る

// ログ
const LOG_ESCAPE = false; // 突破ログを出すなら true

/* ========== DOM ========== */
const laneEl   = document.getElementById('enemy-lane');
const goldEl   = document.getElementById('gold');
const diaEl    = document.getElementById('diamond');
const dpsEl    = document.getElementById('dps');
const chainEl  = document.getElementById('chain');
const stageLabelEl = document.getElementById('stageLabel');
const remainEl = document.getElementById('remain');
const spiritEl = document.querySelector('.spirit');
const stageClearEl = document.getElementById('stage-clear');

const playerHpBarEl   = document.getElementById('player-hp');
const playerHpFillEl  = playerHpBarEl?.querySelector('.fill');
const playerHpLabelEl = document.getElementById('playerHpLabel');

/* ========== Start/Menu ========== */
const startScreenEl  = document.getElementById('start-screen');
const btnNew         = document.getElementById('btn-new');
const btnContinue    = document.getElementById('btn-continue');
const continueHintEl = document.getElementById('continue-hint');
const btnResume = document.getElementById('btn-resume');
const btnRetry  = document.getElementById('btn-retry');
const btnStatus = document.getElementById('btn-status');

/* ========== Guards ========== */
let __INIT_DONE = false;
function setStartHiddenLock(on){ try{ on ? sessionStorage.setItem('startHidden','1') : sessionStorage.removeItem('startHidden'); }catch{} }
function hasStartHiddenLock(){ try{ return sessionStorage.getItem('startHidden') === '1'; }catch{ return false; } }

/* ========== Layout cache ========== */
let laneRect;
function measureRects(){ if (!laneEl) return; laneRect = laneEl.getBoundingClientRect(); }
window.addEventListener('resize', measureRects);
window.addEventListener('orientationchange', () => setTimeout(measureRects, 200));

/* ========== Log ========== */
const MAX_LOG = 50;
function addLog(msg, kind = 'info') {
  const root = document.getElementById('log');
  if (!root) return;
  const div = document.createElement('div');
  div.className = `log-entry ${kind}`;
  div.textContent = msg;

  const firstEntry = root.querySelector('.log-entry');
  if (firstEntry) root.insertBefore(div, firstEntry);
  else {
    const btn = root.querySelector('#btn-bgm');
    if (btn && btn.nextSibling) root.insertBefore(div, btn.nextSibling);
    else root.appendChild(div);
  }

  const entries = root.querySelectorAll('.log-entry');
  for (let i = entries.length - 1; i >= MAX_LOG; i--) entries[i].remove();
}
function logAttack(chainCount, totalDamage) {
  addLog(`連鎖×${chainCount}！ 合計 ${Math.round(totalDamage)} ダメージ`, 'gain');
}

/* ========== Save/Load ========== */
const SAVE_KEY = 'idleLightningSaveV64';
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

/* ========== State & watchdog ========== */
const gs = { floor:1, chapter:1, stage:1, isNight:false, hpScale:1.0, paused:false, running:false };
const watchdog = { lastProgress: performance.now(), lastFailAt: 0, lastStageStartAt: 0 };
function touchProgress(){ watchdog.lastProgress = performance.now(); }

/* ========== Currency/HP/UI ========== */
let gold = 0, diamonds = 0, dpsSmoothed = 0;
function refreshCurrencies(){ if (goldEl) goldEl.textContent = gold; if (diaEl) diaEl.textContent = diamonds; if (dpsEl) dpsEl.textContent = Math.round(dpsSmoothed); mountStatusGoldPill(); }
refreshCurrencies();

let playerHpMax = 100, playerHp = playerHpMax;
function updatePlayerHpUI(){
  const ratio = Math.max(0, Math.min(1, playerHp / playerHpMax));
  if (playerHpFillEl) playerHpFillEl.style.width = (ratio * 100).toFixed(1) + '%';
  if (playerHpLabelEl) playerHpLabelEl.textContent = `${Math.max(0,Math.ceil(playerHp))}/${playerHpMax}`;
}
updatePlayerHpUI();

/* ========== Stage UI ========== */
function updateStageLabel(){ if (stageLabelEl) stageLabelEl.textContent = `${gs.chapter}-${gs.stage} / ${gs.floor}F${gs.isNight ? ' 🌙' : ''}`; }
function updateRemainLabel(){
  if (!remainEl) return;
  const left = Math.max(0, spawnPlan.total - spawnPlan.spawned) + spawnPlan.alive;
  remainEl.textContent = String(left);
}
updateStageLabel();

/* ========== Lightning ========== */
// ★ 基本射程はここ（初期値を変えたいなら range を変更）
const lightning = { baseDmg: 8, cooldown: 2.0, cooldownBase: undefined, range: 150, baseRange: undefined, chainCount: 2, falloff: 0.85, timer: 0 };
chainEl && (chainEl.textContent = `${lightning.chainCount}/15`);

/* ========== EnemyDB ========== */
const DB = (function(){
  const F = window.EnemyDB || {};
  const defs = F.defs || {
    swarm: { name:'Swarm', icon:'🦂', size:28, speed:120, hp:20, dmg:8, reward:1, atk:{ range:26, windup:0.50, active:0.20, lunge:12, rate:0.9, recoil:0.18 } },
    runner:{ name:'Runner',icon:'🦅', size:26, speed:170, hp:14, dmg:10, reward:1, atk:{ range:24, windup:0.40, active:0.18, lunge:14, rate:1.1, recoil:0.15 } },
    tank:  { name:'Tank',  icon:'🦏', size:34, speed:90,  hp:90, dmg:20, reward:5, atk:{ range:30, windup:0.70, active:0.25, lunge:10, rate:0.60, recoil:0.30 } },
  };
  const weights = F.weights || (() => ([ { type:'swarm', w:0.60 }, { type:'runner', w:0.25 }, { type:'tank', w:0.15 } ]));
  const chapterHpMul = F.chapterHpMul || (chapter => 1 + (chapter-1)*0.15);
  const nightHpMul   = F.nightHpMul   || (isNight => isNight? 1.8 : 1.0);
  return { defs, weights, chapterHpMul, nightHpMul };
})();

/* ========== Enemy pool ========== */
const enemyPool = [];
function getEnemyEl(){ const el = enemyPool.pop(); if (el) return el; const e = document.createElement('div'); e.className = 'enemy'; const icon = document.createElement('span'); icon.className = 'icon'; const hp = document.createElement('div'); hp.className = 'hp'; e.append(icon, hp); return e; }
function releaseEnemyEl(el){ el.remove(); enemyPool.push(el); }
function resetEnemyEl(el){
  el.className = 'enemy'; el.style.cssText = ''; el.dataset.eid = ''; el.dataset.alive = '';
  let iconEl = el.querySelector('.icon'); let hpEl   = el.querySelector('.hp');
  if (!iconEl) { iconEl = document.createElement('span'); iconEl.className='icon'; el.prepend(iconEl); }
  if (!hpEl)   { hpEl   = document.createElement('div');   hpEl.className='hp';  el.append(hpEl); }
  hpEl.style.width = '100%'; el.setAttribute('data-hp', '');
}

/* ========== Stage plan & spawn ========== */
function stageTotalCount(chapter, stage) { const base = 8 + (stage - 1); return (stage === 10) ? Math.round(base * 2) : base; }
function hpMultiplier(){ return gs.hpScale * DB.chapterHpMul(gs.chapter) * DB.nightHpMul(gs.isNight); }

const MAX_CONCURRENT = 40; const NIGHT_DIAMOND_RATE = 0.2;
let spawnPlan = { total: 0, spawned: 0, alive: 0 };
let spawnTimer = 0, baseSpawnDelay = 1000, burstLeft = 0;

function setupStageCounters(){
  spawnPlan.total   = stageTotalCount(gs.chapter, gs.stage);
  spawnPlan.spawned = 0;
  spawnPlan.alive   = 0;
  spawnTimer = 0;
  burstLeft = Math.min(3, spawnPlan.total);
  baseSpawnDelay = Math.max(450, 800 - gs.stage*25);
  updateStageLabel(); updateRemainLabel();
  addLog(`Stage 開始：${gs.chapter}-${gs.stage} / ${gs.floor}F${gs.isNight?' 🌙':''}`, 'dim');
  watchdog.lastStageStartAt = performance.now();
  touchProgress();
}

function pickEnemyType(){ const weights = DB.weights(gs.chapter, gs.stage); const r = Math.random(); let acc = 0; for (const x of weights) { acc += x.w; if (r <= acc) return x.type; } return weights[0].type; }

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

  // === 画面右・外側スポーン（常に右から） ===
  const startX = laneWidthCached + (SPAWN_OFF_X * 0.7) + Math.random() * (SPAWN_OFF_X * 0.6);
  const startY = Math.max(16, Math.min(laneHeightCached - 16, laneHeightCached * (0.08 + 0.84 * Math.random())));

  const hpMax = Math.max(1, Math.round(def.hp * hpMultiplier()));

  el.style.transform = `translate(${startX}px, ${startY}px)`;
  el.querySelector('.hp').style.width = '100%';
  el.setAttribute('data-hp', hpMax);

  enemies.push({
    eid, el, def,
    x: startX, y: startY,
    vx: 0, vy: 0,
    speed: def.speed * ENEMY_SPEED_MUL,
    hp: hpMax, maxHp: hpMax,
    reward: def.reward, dmg: def.dmg,
    t: 0,
    swayAmp: 6 + Math.random()*10,
    swayFreq: 1.0 + Math.random()*0.8,
    state: 'chase',
    st: 0,
    atkCool: 0,
    strikeFromX: 0, strikeFromY: 0, strikeToX: 0, strikeToY: 0,
    strikeHitDone: false, recoilFromX: 0, recoilFromY: 0, recoilToX: 0, recoilToY: 0,
    spawnGrace: SPAWN_GRACE_SEC,
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

/* ========== Beam ========== */
const beamPool = [];
function getBeamEl(){ const el = beamPool.pop(); if(el) return el; const b=document.createElement('div'); b.className='beam'; return b; }
function releaseBeamEl(el){ el.remove(); beamPool.push(el); }
function spawnBeam(x1, y1, x2, y2, life = 0.12) {
  const el = getBeamEl();
  laneEl.appendChild(el);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx) * 180 / Math.PI;
  el.style.left = `${x1}px`; el.style.top  = `${y1}px`;
  el.style.width = `${Math.max(1, len)}px`; el.style.transform = `rotate(${ang}deg)`;
  setTimeout(() => el.classList.add('fade'), (life * 1000 * 0.6) | 0);
  setTimeout(() => { el.classList.remove('fade'); releaseBeamEl(el); }, (life * 1000) | 0);
}

/* ========== Helpers ========== */
function centerScreen(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

/* ========== EXP Fallback ========== */
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
  addExp(v, why){ if (window.Exp?.addExp) window.Exp.addExp(v, why); else addLog(`+${v} EXP (${why})`, 'gain'); }
};

/* ========== Remove enemy ========== */
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

/* ========== Player damage ========== */
function damagePlayer(amount){
  playerHp = Math.max(0, playerHp - (Number.isFinite(amount) ? amount : 0));
  updatePlayerHpUI();
  if (playerHp <= 0) {
    addLog('💥 HPが0になった…章の初めからリトライ！', 'alert');
    failStage();
  }
}

/* ========== SFX (attack) ========== */
const Sfx = { attackPool: [], attackIdx: 0, inited:false };
function ensureSfxInit(){
  if (Sfx.inited) return;
  try {
    // デフォルトのパス（index.htmlに <audio id="sfx-attack"> があればそちら優先）
    let src = 'assets/audio/attack.mp3';
    const el = document.getElementById('sfx-attack');
    if (el && el.getAttribute('src')) src = el.getAttribute('src');
    for (let i=0;i<ATTACK_SFX_POLY;i++){
      const a = new Audio();
      a.src = src;
      a.preload = 'auto';
      a.volume = ATTACK_SFX_VOL;
      Sfx.attackPool.push(a);
    }
  } catch {}
  Sfx.inited = true;
}
function soundAllowed(){
  return SFX_FOLLOWS_BGM ? bgmEnabled() : true;
}
function playAttackSfx(){
  if (!soundAllowed()) return;
  ensureSfxInit();
  const pool = Sfx.attackPool;
  if (!pool.length) return;
  const a = pool[Sfx.attackIdx++ % pool.length];
  try { a.currentTime = 0; a.play(); } catch {}
}

/* ========== Attack ========== */
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
  if (!cand.length) { lightning.timer = lightning.cooldown; return; }

  cand.sort((a,b)=>a.d2-b.d2);
  const maxHits = Math.min(lightning.chainCount + 1, cand.length);

  const used = new Set();
  let dmg = lightning.baseDmg;
  let dealtTotal = 0;

  const first = cand[0];

  // 視覚と同期：ビーム発射直後に鳴らす
  spawnBeam(sx, sy, first.ex, first.ey);
  playAttackSfx();

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
      if (gs.isNight && Math.random() < NIGHT_DIAMOND_RATE) { diamonds++; diaEl && (diaEl.textContent = diamonds); addLog('💎 ダイヤを獲得！', 'gain'); }
      const gMul = window.Status ? window.Status.getGoldMul() : 1;
      const gainG = Math.max(1, Math.round((e.reward||1) * gMul));
      gold += gainG; goldEl && (goldEl.textContent = gold);

      const expGain = ExpAPI.expFromKill(gs, e.def && e.def.name ? e.def.name.toLowerCase() : 'swarm');
      ExpAPI.addExp(expGain, 'kill');

      removeEnemyById(e.eid, { by:'beam', fade:true });
    }
  }

  logAttack(used.size, dealtTotal);
  lightning.timer = lightning.cooldown;
  touchProgress();
}

/* ========== Loop & AI ========== */
let last;
let clearPending = false;
function getSpiritCenter(){ return centerScreen(spiritEl); }
function getEnemyCenter(e){ return centerScreen(e.el); }
function enemyRadius(e){ const size = (e.def?.size) || 28; return Math.max(10, size * 0.40); }
function spiritRadius(){ const sr = spiritEl.getBoundingClientRect(); return Math.max(sr.width, sr.height) * 0.42 || 16; }

// 例外が出ても止まらない gameLoop
function gameLoop(now = performance.now()) {
  let dt = (now - last) / 1000; 
  last = now;
  if (!Number.isFinite(dt) || dt <= 0) dt = 0.016;
  dt = Math.min(dt, 0.033);

  try {
    if (!gs.running || gs.paused) return;

    if (!laneRect || !Number.isFinite(laneRect.width) || laneRect.width === 0) {
      measureRects();
      if (!laneRect || !Number.isFinite(laneRect.width) || laneRect.width === 0) return;
    }

    // レーンの変化を追従
    const r = laneEl.getBoundingClientRect();
    if (Math.abs(r.top - laneRect.top) > 1 || Math.abs(r.height - laneRect.height) > 1 || Math.abs(r.left - laneRect.left) > 1) {
      laneRect = r;
    }

    const scScr = getSpiritCenter();
    let sxLane = Math.max(0, Math.min(laneRect.width,  scScr.x - laneRect.left));
    let syLane = Math.max(0, Math.min(laneRect.height, scScr.y - laneRect.top));

    const rS = spiritRadius();

    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      e.t += dt; e.st += dt;
      if (e.atkCool > 0) e.atkCool -= dt;
      if (e.spawnGrace > 0) e.spawnGrace -= dt;

      let dx = sxLane - e.x, dy = syLane - e.y;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = dx / dist, ny = dy / dist;

      const A  = e.def.atk;
      const rE = enemyRadius(e);
      const rr = rS + rE + 2;
      const inMelee = dist <= Math.max(rr, A.range);

      if (e.state === 'chase') {
        const desiredVx = nx * e.speed, desiredVy = ny * e.speed;
        const steer = 0.5;
        e.vx += (desiredVx - e.vx) * steer;
        e.vy += (desiredVy - e.vy) * steer;
        const sway = Math.sin(e.t * (2 * Math.PI) * e.swayFreq) * e.swayAmp;
        e.x += e.vx * dt;
        e.y += (e.vy + sway * 0.8) * dt;

        if (dist < (rr + 6)) { e.x -= nx * (rr + 6 - dist) * 0.10; e.y -= ny * (rr + 6 - dist) * 0.10; }

        if (inMelee && e.atkCool <= 0) { e.state = 'windup'; e.st = 0; e.vx = e.vy = 0; e.el.classList.add('pose-windup'); }
      }
      else if (e.state === 'windup') {
        e.vx = e.vy = 0;
        if (e.st >= A.windup) {
          e.strikeFromX = e.x; e.strikeFromY = e.y; e.strikeToX = e.x - A.lunge; e.strikeToY = e.y;
          e.strikeHitDone = false; e.state = 'strike'; e.st = 0; e.el.classList.remove('pose-windup'); e.el.classList.add('pose-strike');
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

          e.recoilFromX = e.x; e.recoilFromY = e.y; e.recoilToX = e.strikeFromX; e.recoilToY = e.strikeFromY;
          e.state = 'recoil'; e.st = 0; e.atkCool = A.rate; e.el.classList.remove('pose-strike'); e.el.classList.add('pose-recoil');
        }
      }
      else if (e.state === 'recoil') {
        e.vx = e.vy = 0;
        const t = Math.min(1, e.st / A.recoil);
        const rx = e.recoilFromX + (e.recoilToX - e.recoilFromX) * t;
        const ry = e.recoilFromY + (e.recoilToY - e.recoilFromY) * t;
        e.x = rx; e.y = ry;
        if (e.st >= A.recoil) {
          e.x = e.recoilToX; e.y = e.recoilToY; e.vx = 0; e.vy = 0;
          e.state = 'chase'; e.st = 0; e.el.classList.remove('pose-recoil');
        }
      }

      e.el.style.transform = `translate(${e.x}px, ${e.y}px)`;

      const ec = getEnemyCenter(e);
      const br = laneRect;
      const marginX = ESCAPE_MARGIN_X, marginY = ESCAPE_MARGIN_Y;
      if (e.spawnGrace <= 0) {
        if (ec.x < br.left - marginX || ec.x > br.right + marginX || ec.y < br.top  - marginY || ec.y > br.bottom + marginY) {
          const escDmg = Math.ceil((Number.isFinite(e.dmg) ? e.dmg : 5) * 0.5);
          if (LOG_ESCAPE) addLog(`突破（escape）：${e.def.name}（-${escDmg} HP）`, 'alert');
          damagePlayer(escDmg);
          removeEnemyById(e.eid, { by:'escape', fade:false });
          continue;
        }
      }
    }

    tryAttack(dt);
    trySpawn(dt);

    // クリア検知（遅延して遷移）
    if (!clearPending && spawnPlan.spawned >= spawnPlan.total && spawnPlan.alive <= 0 && enemies.length === 0) {
      showClearThenAdvance();
    }

    // Watchdog（停滞対策 + 失敗直後キック）
    const nowMs = performance.now();
    if (gs.running && !gs.paused) {
      const noEnemy = enemies.length === 0 && spawnPlan.alive === 0;
      const notSpawning = spawnPlan.spawned === 0 && spawnPlan.total > 0;
      const sinceStart = nowMs - watchdog.lastStageStartAt;
      const sinceFail  = nowMs - watchdog.lastFailAt;
      const sinceProg  = nowMs - watchdog.lastProgress;

      if (sinceFail < 4000 && spawnPlan.spawned === 0 && sinceStart > 1500) {
        addLog('🧯 リカバリ: スポーンを起動', 'dim');
        if (spawnPlan.total === 0) setupStageCounters();
        spawnEnemy();
        touchProgress();
      }

      if ( (noEnemy && notSpawning && sinceStart > 1200 && sinceFail > 600 && sinceProg > 2000) ||
           (sinceProg > 6000) ) {
        addLog('🛠 再起動ガード: ステージを再セット', 'dim');
        startStageHead();
        touchProgress();
      }
    }
  } catch (err) {
    addLog('⚠️ 内部エラーを検出。次フレームへ復帰します', 'alert');
  } finally {
    requestAnimationFrame(gameLoop);
  }
}

/* ========== Stage flow ========== */
function startStageHead() {
  clearPending = false;
  clearAllEnemies();
  enemySeq = 1;

  gs.isNight = (gs.stage === 10);
  setupStageCounters();
  playerHp = playerHpMax;
  updatePlayerHpUI();
  measureRects();
  applyBgmForStage();
}

function nextStageInternal() {
  addLog(`✅ クリア：${gs.chapter}-${gs.stage} / ${gs.floor}F`, 'gain');
  const clearExp = ExpAPI.expFromStageClear(gs);
  ExpAPI.addExp(clearExp, 'clear');

  gs.stage += 1;
  if (gs.stage > 10) {
    gs.stage = 1; gs.isNight = false; gs.chapter += 1;
    if (gs.chapter > 30) { gs.chapter = 1; gs.floor += 1; gs.hpScale = +(gs.hpScale * 1.5).toFixed(6); addLog(`🔺 階層UP！ いま ${gs.floor}F（HP係数×${gs.hpScale.toFixed(2)}）`, 'gain'); }
  }
  clearAllEnemies();
  startStageHead();
  saveGame();
  emitStageChange();
}

function showClearThenAdvance(){
  clearPending = true;
  if (stageClearEl){
    stageClearEl.setAttribute('aria-hidden','false');
    setTimeout(()=> stageClearEl.setAttribute('aria-hidden','true'), CLEAR_PAUSE_MS - 250);
  }
  setTimeout(()=> { nextStageInternal(); }, CLEAR_PAUSE_MS);
}

function failStage() {
  clearAllEnemies();
  gs.stage = 1; gs.isNight = false;
  spawnTimer = 0; baseSpawnDelay = 1000;
  addLog(`↩︎ リトライ：${gs.chapter}-1 / ${gs.floor}F から`, 'alert');

  gs.paused = false; gs.running = true;
  last = performance.now();

  startStageHead();
  saveGame();

  watchdog.lastFailAt = performance.now();
  emitStageChange();
}

function clearAllEnemies(){ while (enemies.length) { const { eid } = enemies[enemies.length - 1]; removeEnemyById(eid, { by:'clear', fade:false }); } }

/* ========== New Game: hard reset ========== */
let __expResetRequested = false;

function resetAllProgressHard(){
  try { localStorage.removeItem(SAVE_KEY); } catch {}

  gold = 0; diamonds = 0; dpsSmoothed = 0;
  gs.floor = 1; gs.chapter = 1; gs.stage = 1; gs.isNight = false; gs.hpScale = 1.0;
  playerHpMax = 100; playerHp = playerHpMax; updatePlayerHpUI();
  lightning.baseDmg = 8; lightning.cooldown = 2.0; lightning.range = 380; lightning.chainCount = 2;

  clearAllEnemies(); enemySeq = 1; updateRemainLabel();

  try { 
    if (window.Exp && typeof window.Exp.reset === 'function') {
      window.Exp.reset(); 
    } else {
      __expResetRequested = true;
    }
  } catch {}

  try { window.Status?.reset?.(); } catch {}

  // idleLightning* を全削除（このゲーム専用キーの掃除）
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i) || '';
      if (k.startsWith('idleLightning')) localStorage.removeItem(k);
    }
  } catch {}

  refreshCurrencies(); updateStageLabel();
}

/* ========== GameAPI ========== */
const listeners = { stageChange: new Set() };
function emitStageChange(){ listeners.stageChange.forEach(fn=>{ try{ fn(getStageInfo()); }catch{} }); }
function getStageInfo(){ return { floor:gs.floor, chapter:gs.chapter, stage:gs.stage, isNight:gs.isNight }; }

window.GameAPI = {
  getGold: ()=>gold, addGold:(v)=>{ gold+=v; refreshCurrencies(); saveGame(); },
  spendGold:(v)=>{ if (gold>=v){ gold-=v; refreshCurrencies(); saveGame(); return true;} return false; },
  getDiamonds: ()=>diamonds, addDiamonds:(v)=>{ diamonds+=v; refreshCurrencies(); saveGame(); },

  lightning,
  setBaseDmg:(v)=>{ lightning.baseDmg = Math.max(1, v); saveGame(); },
  setCooldown:(v)=>{ lightning.cooldown = Math.max(0.15, v); saveGame(); },
  setRange:(v)=>{ lightning.range = Math.max(60, v); saveGame(); },
  setChain:(v)=>{ lightning.chainCount = Math.max(0, Math.min(14, v)); chainEl && (chainEl.textContent = `${lightning.chainCount}/15`); saveGame(); },

  getPlayerHp: ()=>({ hp:playerHp, max:playerHpMax }),
  healPlayer:(v)=>{ playerHp=Math.min(playerHpMax, playerHp+v); updatePlayerHpUI(); saveGame(); },
  setPlayerHpMax:(m)=>{ playerHpMax=Math.max(1,m); playerHp=Math.min(playerHp,playerHpMax); updatePlayerHpUI(); saveGame(); },

  getStageInfo, onStageChange:(fn)=>{ listeners.stageChange.add(fn); }, offStageChange:(fn)=>{ listeners.stageChange.delete(fn); },
  addLog, updateRemainLabel,
};

/* ========== BGM ========== */
const BGM_KEY = 'bgmEnabled';
function bgmEnabled(){ const v = localStorage.getItem(BGM_KEY); return v == null ? true : v === '1'; }
function setBgmEnabled(on){ try { localStorage.setItem(BGM_KEY, on ? '1' : '0'); } catch {} }
function ensureBgmInit(){
  const day = document.getElementById('bgm-day'); const night = document.getElementById('bgm-night');
  if (!day || !night) return;
  day.volume = 0.7; night.volume = 0.7;
  day.loop = true; night.loop = true;
}
function isAudioPlaying(a){ try{ return a && !a.paused && a.currentTime > 0 && !a.ended; }catch{return false;} }
let __bgmRetryT = null;
function kickBgmSoon(){ clearTimeout(__bgmRetryT); __bgmRetryT = setTimeout(()=>applyBgmForStage(), 200); }

/* === Audio Unlock（再訪/PWAで音が出なくなる対策） === */
let __bgmUnlocked = false;
async function unlockBgmOnce(){
  if (__bgmUnlocked) return;
  const day   = document.getElementById('bgm-day');
  const night = document.getElementById('bgm-night');
  if (!day || !night) return;

  const prime = async (a) => {
    try {
      const oldVol = a.volume;
      a.volume = 0.0;
      a.muted  = false;
      if (a.readyState === 0) a.load();
      await a.play().catch(()=>{});
      a.pause();
      a.currentTime = 0;
      a.volume = oldVol;
    } catch {}
  };

  await prime(day);
  await prime(night);

  ensureSfxInit();
  for (const a of Sfx.attackPool) { await prime(a); }

  __bgmUnlocked = true;
}
function wireFirstGestureUnlock(){
  const fn = () => { unlockBgmOnce(); };
  document.addEventListener('pointerdown', fn, { once:true, passive:true });
  document.addEventListener('keydown',     fn, { once:true });
}

async function applyBgmForStage(){
  ensureBgmInit();
  const day   = document.getElementById('bgm-day');
  const night = document.getElementById('bgm-night');
  if (!day || !night) return;

  const desired = gs.isNight ? night : day;
  const other   = gs.isNight ? day   : night;

  if (!bgmEnabled()){
    try{ day.pause(); night.pause(); }catch{}
    const btn = document.getElementById('btn-bgm');
    if (btn){ btn.setAttribute('aria-pressed','false'); btn.textContent = '♪ BGM OFF'; }
    return;
  }

  try{
    if (desired.readyState === 0) desired.load();
    if (other && !other.paused) other.pause();
    desired.muted = false;
    if (!isAudioPlaying(desired)) {
      await desired.play();
    }
  }catch(e){
    kickBgmSoon(); // 拒否時は少し後に再試行
  }

  const btn = document.getElementById('btn-bgm');
  if (btn){ btn.setAttribute('aria-pressed','true'); btn.textContent = '♪ BGM ON'; }
}
function wireBgmSelfRecovery(){
  const day   = document.getElementById('bgm-day');
  const night = document.getElementById('bgm-night');
  if (!day || !night) return;
  if (day.dataset.rewire === '1') return;
  const rearm = ()=>{ if (bgmEnabled() && !document.hidden) kickBgmSoon(); };
  ['stalled','suspend','abort','error','emptied','waiting','ended','pause'].forEach(ev=>{
    day.addEventListener(ev, rearm);
    night.addEventListener(ev, rearm);
  });
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) kickBgmSoon(); });
  day.dataset.rewire = night.dataset.rewire = '1';
}
function wireBgmToggleButton(){
  const btn = document.getElementById('btn-bgm'); if (!btn) return;
  if (btn.dataset.wired === '1') return;
  const syncBtn = () => { btn.setAttribute('aria-pressed', String(bgmEnabled())); btn.textContent = bgmEnabled() ? '♪ BGM ON' : '♪ BGM OFF'; };
  syncBtn();
  btn.addEventListener('click', async () => { setBgmEnabled(!bgmEnabled()); await applyBgmForStage(); });
  btn.dataset.wired = '1';
  window.GameAPI?.onStageChange?.(applyBgmForStage);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) applyBgmForStage(); }, { once:false });
}

/* ========== Status gold pill (title area) ========== */
function queryByText(root, tagSelector, contains){
  const els = root.querySelectorAll(tagSelector);
  for (const el of els) { if ((el.textContent||'').trim().includes(contains)) return el; }
  return null;
}
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
      pill.style.cssText = `margin-left:.5rem; padding:.1rem .45rem; border:1px solid rgba(255,215,0,.7);
        border-radius:999px; font-size:.85em; white-space:nowrap; background:rgba(255,215,0,.08); vertical-align:baseline; display:inline-block;`;
      title.appendChild(pill);
    }
    pill.textContent = `💰 ${gold.toLocaleString()}`;
  }catch{}
}

/* ========== Init ========== */
function init() {
  if (__INIT_DONE) return;
  __INIT_DONE = true;
  measureRects();
  addLog('タイトル待機中：「はじめから／つづきから」を選んでください', 'dim');
  last = performance.now();
  requestAnimationFrame(gameLoop);
}
window.addEventListener('load', () => {
  init();
  showStartScreen();
  setTimeout(()=> {
    if (window.Status && window.GameAPI){
      if (lightning.cooldownBase==null) lightning.cooldownBase = lightning.cooldown;
      if (lightning.baseRange==null)    lightning.baseRange    = lightning.range;
      try{ window.Status.init(window.GameAPI); }catch{}
      mountStatusGoldPill();
    }
    if (__expResetRequested && window.Exp && typeof window.Exp.reset === 'function'){
      try { window.Exp.reset(); } catch {}
      __expResetRequested = false;
    }
  }, 0);
  btnStatus?.addEventListener('click', ()=>{ if (window.Status && window.GameAPI) window.Status.open(window.GameAPI); setTimeout(mountStatusGoldPill, 0); });
  wireBgmToggleButton();
  wireBgmSelfRecovery();
  wireFirstGestureUnlock(); // ★ 最初のジェスチャーで音解禁
});

/* ========== Controls（最後にまとめる） ========== */
function showStartScreen() {
  if (hasStartHiddenLock()) { hideStartScreen(); return; }
  if (hasSave()) { btnContinue && (btnContinue.disabled = false); if (continueHintEl) continueHintEl.textContent = '前回の続きから再開できます。'; }
  else { btnContinue && (btnContinue.disabled = true); if (continueHintEl) continueHintEl.textContent = 'セーブデータがあれば「つづきから」が有効になります。'; }
  startScreenEl?.setAttribute('aria-hidden', 'false');
  if (startScreenEl) startScreenEl.style.removeProperty('display');
  gs.running = false;
}
function hideStartScreen() {
  startScreenEl?.setAttribute('aria-hidden', 'true');
  if (startScreenEl) startScreenEl.style.display = 'none';
  gs.running = true; gs.paused = false; measureRects(); startStageHead();
  setStartHiddenLock(true);
}

btnNew?.addEventListener('click', (e) => {
  e.preventDefault();
  unlockBgmOnce();                         // ★ クリックで確実に音を解禁
  resetAllProgressHard(); saveGame(); hideStartScreen();
});
btnContinue?.addEventListener('click', (e) => {
  e.preventDefault();
  unlockBgmOnce();                         // ★ クリックで確実に音を解禁
  const data = loadGame();
  if (data) {
    gold = data.gold ?? gold; diamonds = data.diamonds ?? 0; refreshCurrencies();
    gs.floor = data.floor ?? 1; gs.chapter = data.chapter ?? 1; gs.stage = data.stage ?? 1; gs.isNight = !!data.isNight; gs.hpScale = data.hpScale ?? 1.0;
    playerHpMax = data.playerHpMax ?? 100; playerHp = data.playerHp ?? playerHpMax; updatePlayerHpUI();
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

btnResume?.addEventListener('click', (e) => { e.preventDefault(); gs.paused = false; addLog('▶ 再開', 'dim'); applyBgmForStage(); });
btnRetry ?.addEventListener('click', (e) => { e.preventDefault(); addLog('↻ リトライ（章の頭へ）', 'alert'); failStage(); });

setInterval(() => { if (gs.running && !gs.paused) saveGame(); }, 5000);