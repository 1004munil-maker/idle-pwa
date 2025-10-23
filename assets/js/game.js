/* =========================================================
   Idle Lightning - game.js (EnemyDB連携)
   v6.5.2-gate
   - Audio Gate: 押下直後にビープ→WebAudio解禁→即BGM起動
   - WebAudio一本化（BGM/SFX）
   - pageshow/focus/visibilitychange で自己復帰
   - 右外スポーン/ウォッチドッグ/ハードリセット維持
   - 攻撃SFXはビーム発射と同期
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
const SFX_FOLLOWS_BGM = true; // false ならBGM OFFでもSFXは鳴る

// ログ
const LOG_ESCAPE = false;

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
  if (!root) { try { console.warn('[addLog] #log not found:', msg); } catch {} return; }
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
function refreshCurrencies(){
  if (goldEl) goldEl.textContent = gold;
  if (diaEl)  diaEl.textContent = diamonds;
  if (dpsEl)  dpsEl.textContent = Math.round(dpsSmoothed);
  mountStatusGoldPill();
}
refreshCurrencies();

let playerHpMax = 100, playerHp = playerHpMax;
function updatePlayerHpUI(){
  const ratio = Math.max(0, Math.min(1, playerHp / playerHpMax));
  if (playerHpFillEl)  playerHpFillEl.style.width = (ratio * 100).toFixed(1) + '%';
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
// cooldown は「秒」単位。2.00 なら 2秒に1回。
const lightning = { baseDmg: 8, cooldown: 2.00, cooldownBase: undefined, range: 160, baseRange: undefined, chainCount: 2, falloff: 0.85, timer: 0 };
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
function getEnemyEl(){
  const el = enemyPool.pop();
  if (el) return el;
  const e = document.createElement('div'); e.className = 'enemy';
  const icon = document.createElement('span'); icon.className = 'icon';
  const hp   = document.createElement('div');  hp.className   = 'hp';
  e.append(icon, hp);
  return e;
}
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

const MAX_CONCURRENT = 40;
const NIGHT_DIAMOND_RATE = 0.10;
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

function pickEnemyType(){
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

  // 右・オフスクリーンスポーン
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

/* ========== SFX（WebAudio統一） ========== */
function soundAllowed(){ return SFX_FOLLOWS_BGM ? bgmEnabled() : true; }
function playAttackSfx(){ if (!soundAllowed()) return; HardAudioKit.playSfx('attack'); }

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
  // 射程内にいない時は次回まできっちり待つ
  if (!cand.length) { lightning.timer = lightning.cooldown; return; }

  cand.sort((a,b)=>a.d2-b.d2);
  const maxHits = Math.min(lightning.chainCount + 1, cand.length);

  const used = new Set();
  let dmg = lightning.baseDmg;
  let dealtTotal = 0;

  const first = cand[0];

  // ビーム発射直後に鳴らす
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

    // レーン変化を追従
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
        const sway = Math.sin(e.t * (2 * Math.PI * e.swayFreq)) * e.swayAmp;
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

    // クリア検知
    if (!clearPending && spawnPlan.spawned >= spawnPlan.total && spawnPlan.alive <= 0 && enemies.length === 0) {
      showClearThenAdvance();
    }

    // Watchdog
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
    try { console.error('[gameLoop error]', err); } catch {}
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
  lightning.baseDmg = 8; lightning.cooldown = 2.00; lightning.range = 380; lightning.chainCount = 2;

  clearAllEnemies(); enemySeq = 1; updateRemainLabel();

  try {
    if (window.Exp && typeof window.Exp.reset === 'function') {
      window.Exp.reset();
    } else {
      __expResetRequested = true;
    }
  } catch {}

  try { window.Status?.reset?.(); } catch {}

  // idleLightning* 全掃除
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

/* ========== BGM/SFX: iOS PWAハード対応 ========== */
const BGM_KEY = 'bgmEnabled';
function bgmEnabled(){ const v = localStorage.getItem(BGM_KEY); return v == null ? true : v === '1'; }
function setBgmEnabled(on){ try { localStorage.setItem(BGM_KEY, on ? '1' : '0'); } catch {} }

/* ---- HardAudioKit（WebAudio一本化） ---- */
const HardAudioKit = (() => {
  let ctx = null, unlocked = false, bgmNode = null, bgmGain = null, sfxGain = null;
  const BUFS = {};
  const SRC = {
    day:   './assets/audio/bgm_day.mp3',
    night: './assets/audio/bgm_night.mp3',
    attack:'./assets/audio/attack.mp3',
    success:'./assets/audio/success.mp3',
    failed: './assets/audio/failed.mp3',
    upg:    './assets/audio/upg.mp3'
  };

  function newCtx(){ const C = window.AudioContext||window.webkitAudioContext; return C? new C(): null; }
  function ensureCtx(){ if (!ctx) ctx = newCtx(); return ctx; }
  async function resumeCtx(){
    const ac = ensureCtx(); if (!ac) return;
    if (ac.state === 'suspended' || ac.state === 'interrupted') { try{ await ac.resume(); }catch{} }
  }

  // 押した“瞬間”に鳴る（同期ビープ）
  function tapPrimeSync(){
    try{
      ctx = ensureCtx();
      if (!ctx) return false;
      if (!bgmGain){ bgmGain = ctx.createGain(); bgmGain.gain.value = 0.7; bgmGain.connect(ctx.destination); }
      if (!sfxGain){ sfxGain = ctx.createGain(); sfxGain.gain.value = ATTACK_SFX_VOL; sfxGain.connect(ctx.destination); }
      const osc = ctx.createOscillator(); const g = ctx.createGain();
      g.gain.value = 0.0001; g.connect(ctx.destination);
      osc.type='sine'; osc.frequency.value = 880; osc.connect(g);
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t+0.07);
      try{ osc.start(t); osc.stop(t+0.08); }catch{}
      unlocked = true;
      return true;
    }catch{ return false; }
  }

  async function unlockAsync(){
    await resumeCtx();
    try{
      const b = ctx.createBuffer(1,1,22050);
      const s = ctx.createBufferSource(); s.buffer=b; s.connect(ctx.destination); s.start();
    }catch{}
  }

  async function decode(name){
    if (BUFS[name]) return BUFS[name];
    await resumeCtx();
    const res = await fetch(SRC[name]);
    const arr = await res.arrayBuffer();
    BUFS[name] = await new Promise((ok,ng)=> ctx.decodeAudioData(arr, ok, ng));
    return BUFS[name];
  }

  function stopBgm(){
    if (bgmNode){ try{bgmNode.stop();}catch{} try{bgmNode.disconnect();}catch{} bgmNode=null; }
  }

  async function playBgm(which){
    if (!bgmEnabled() || !unlocked) return;
    await resumeCtx();
    const key = which==='night' ? 'night' : 'day';
    const buf = await decode(key);
    stopBgm();
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.connect(bgmGain); src.start();
    bgmNode = src;
  }

  async function playSfx(name, volMul=1){
    if (!unlocked) return;
    await resumeCtx();
    const buf = await decode(name);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = (ATTACK_SFX_VOL||0.25)*volMul; src.connect(g).connect(ctx.destination);
    src.start();
  }

  function isUnlocked(){ return unlocked; }
  async function tryResume(){ await resumeCtx(); }

  function rebuild(){
    try{ stopBgm(); }catch{}
    try{ ctx && ctx.close && ctx.close(); }catch{}
    ctx = null; bgmNode = null; bgmGain = null; sfxGain = null;
    unlocked = false;
  }

  return { tapPrimeSync, unlockAsync, playBgm, stopBgm, playSfx, isUnlocked, tryResume, rebuild };
})();

/* ---- ゲートUI ---- */
function showAudioGate(on){
  const g = document.getElementById('audio-gate');
  if (!g) return; g.dataset.show = on?'1':'0'; g.setAttribute('aria-hidden', on?'false':'true');
}
function wireAudioGate(){
  const btn = document.getElementById('audio-gate-btn');
  if (!btn || btn.dataset.wired==='1') return;
  btn.dataset.wired='1';
  const handle = async (e)=>{
    e.preventDefault(); e.stopPropagation();
    HardAudioKit.tapPrimeSync();              // 即ビープ
    await HardAudioKit.unlockAsync();         // 非同期仕上げ
    await HardAudioKit.playBgm(gs.isNight ? 'night' : 'day');
    showAudioGate(false);
    const btnBgm = document.getElementById('btn-bgm');
    if (btnBgm){ btnBgm.setAttribute('aria-pressed','true'); btnBgm.textContent='♪ BGM ON'; }
  };
  ['pointerdown','touchstart','click'].forEach(ev=> btn.addEventListener(ev, handle, {once:true, passive:false}));
}

/* ---- BGM適用 ---- */
async function applyBgmForStage(){
  const btn = document.getElementById('btn-bgm');
  if (!bgmEnabled()){
    HardAudioKit.stopBgm();
    if (btn){ btn.setAttribute('aria-pressed','false'); btn.textContent='♪ BGM OFF'; }
    return;
  }
  if (!HardAudioKit.isUnlocked()){
    showAudioGate(true); wireAudioGate();
    if (btn){ btn.setAttribute('aria-pressed','false'); btn.textContent='♪ BGM OFF'; }
    return;
  }
  await HardAudioKit.playBgm(gs.isNight ? 'night' : 'day');
  if (btn){ btn.setAttribute('aria-pressed','true'); btn.textContent='♪ BGM ON'; }
}

/* ---- トグル＆復帰配線 ---- */
function wireBgmToggleButton(){
  const btn = document.getElementById('btn-bgm'); if (!btn) return;
  if (btn.dataset.wired==='1') return;
  const sync = ()=> btn.textContent = bgmEnabled()? '♪ BGM ON' : '♪ BGM OFF';
  sync();
  btn.addEventListener('click', async ()=>{
    setBgmEnabled(!bgmEnabled());
    if (bgmEnabled()){
      if (!HardAudioKit.isUnlocked()){ showAudioGate(true); wireAudioGate(); }
      else await applyBgmForStage();
    } else {
      await applyBgmForStage();
    }
  });
  btn.dataset.wired='1';
  window.GameAPI?.onStageChange?.(applyBgmForStage);
}

function wireAudioRecovery(){
  window.addEventListener('pageshow', async ()=>{
    await HardAudioKit.tryResume();
    if (!HardAudioKit.isUnlocked()) { showAudioGate(true); wireAudioGate(); }
    else { applyBgmForStage(); }
  });
  window.addEventListener('focus',    async ()=>{ await HardAudioKit.tryResume(); applyBgmForStage(); });
  document.addEventListener('visibilitychange', async ()=>{
    if (!document.hidden){
      await HardAudioKit.tryResume();
      applyBgmForStage();
    }
  });
}

/* ---- 起動時はまずゲートを表示 ---- */
function showAudioGateOnBoot(){ showAudioGate(true); wireAudioGate(); }

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

  // ★ ここが重要
  wireBgmToggleButton();
  wireAudioRecovery();
  showAudioGateOnBoot();
});

/* ========== Controls ========== */
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

btnNew?.addEventListener('click', async (e) => {
  e.preventDefault();
  HardAudioKit.tapPrimeSync(); await HardAudioKit.unlockAsync();  // ★押下直後に解禁
  resetAllProgressHard(); saveGame(); hideStartScreen(); applyBgmForStage();
});
btnContinue?.addEventListener('click', async (e) => {
  e.preventDefault();
  HardAudioKit.tapPrimeSync(); await HardAudioKit.unlockAsync();  // ★押下直後に解禁
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
  hideStartScreen(); applyBgmForStage();
});

btnResume?.addEventListener('click', async (e) => { e.preventDefault(); gs.paused = false; addLog('▶ 再開', 'dim'); await HardAudioKit.tryResume(); applyBgmForStage(); });
btnRetry ?.addEventListener('click', (e) => { e.preventDefault(); addLog('↻ リトライ（章の頭へ）', 'alert'); failStage(); });

setInterval(() => { if (gs.running && !gs.paused) saveGame(); }, 5000);