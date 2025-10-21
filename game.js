/* ============================================
   Idle Lightning - game.js v3.5（フル＆安定版）
   (1) DOM参照
   (2) レイアウト計測（毎フレーム更新）+ VisualViewport監視
   (3) ログ & デバッグドット
   (4) ステータス
   (5) パラメータ（雷・ヒットボックス）
   (6) 敵タイプ（速度&HP）＋抽選
   (7) プール（敵/ビーム）※再利用時の完全初期化
   (8) 配列
   (9) スポーン（TTIログ）
   (10) スポーン間隔
   (11) 画面座標ヘルパ（中心）
   (12) ビーム演出
   (13) 攻撃（連鎖）
   (14) ループ（ステアリング安定版＋円ヒット／脱出／NaN保険）
   (15) スタート画面＆セーブ
   (16) 初期化＆起動
   ============================================ */

/* (1) ---------- DOM参照 ---------- */
const laneEl   = document.getElementById('enemy-lane');
const logEl    = document.getElementById('log');
const goldEl   = document.getElementById('gold');
const diaEl    = document.getElementById('diamond');
const dpsEl    = document.getElementById('dps');
const chainEl  = document.getElementById('chain');
const spiritEl = document.querySelector('.spirit');

const startScreenEl   = document.getElementById('start-screen');
const btnNew          = document.getElementById('btn-new');
const btnContinue     = document.getElementById('btn-continue');
const continueHintEl  = document.getElementById('continue-hint');

/* (2) ---------- レイアウト計測（毎フレーム更新） ---------- */
let laneRect;
function measureRects() { laneRect = laneEl.getBoundingClientRect(); }
window.addEventListener('resize', measureRects);
window.addEventListener('orientationchange', () => setTimeout(measureRects, 200));
if (window.visualViewport) {
  visualViewport.addEventListener('resize', measureRects, { passive: true });
  visualViewport.addEventListener('scroll',  measureRects, { passive: true });
}

/* (3) ---------- ログ & デバッグ ---------- */
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

// デバッグドット（必要に応じて false）
let DEBUG_DOTS = false;
function dbgDot(cls, x, y){
  if(!DEBUG_DOTS) return;
  let el = document.querySelector('.' + cls);
  if(!el){
    el = document.createElement('div');
    el.className = 'dbg-dot ' + cls;
    document.body.appendChild(el);
  }
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
}

/* (4) ---------- ステータス ---------- */
let gold = 0;
let diamonds = 0;
let dpsSmoothed = 0;
goldEl.textContent = gold;
diaEl.textContent  = diamonds;
dpsEl.textContent  = 0;

/* (5) ---------- パラメータ（雷・ヒットボックス） ---------- */
const lightning = {
  baseDmg: 6,
  cooldown: 0.80,
  timer: 0,
  range: 400,       // 射程(px)
  chainCount: 2,    // = 3体ヒット（2+1）
  falloff: 0.85,
};
chainEl.textContent = `${lightning.chainCount}/15`;

const R_SPIRIT = 18; // 画面座標での当たり半径
const R_ENEMY  = 13;

/* (6) ---------- 敵タイプ（速度&HP）＋抽選 ---------- */
const ENEMY_TYPES = {
  swarm:  { speed:120, hp:100, reward:1 },
  runner: { speed:160, hp: 70, reward:1 },
  tank:   { speed: 90, hp:260, reward:5 },
};
const SPAWN_WEIGHTS = [
  { type: 'swarm',  w: 0.60 },
  { type: 'runner', w: 0.25 },
  { type: 'tank',   w: 0.15 },
];
function pickEnemyType() {
  const r = Math.random(); let acc = 0;
  for (const x of SPAWN_WEIGHTS) { acc += x.w; if (r <= acc) return x.type; }
  return 'swarm';
}

/* (7) ---------- プール（敵/ビーム） ---------- */
const enemyPool = [];
const beamPool  = [];

// 再利用時の「完全初期化」関数（暴走の元を断つ）
function resetEnemyEl(el){
  el.className = 'enemy';           // hit/dead除去
  el.style.transform = '';          // 古いtransform破棄
  el.style.animation = 'none';      // 走ってるアニメ停止
  // reflowしてから解除（Safari対策）
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight;
  el.style.animation = '';
  const hp = el.querySelector('.hp');
  if (hp) hp.style.width = '100%';
  el.removeAttribute('data-hp');
}

function getEnemyEl() {
  const el = enemyPool.pop();
  if (el) { resetEnemyEl(el); return el; }
  const e = document.createElement('div');
  e.className = 'enemy';
  const hp = document.createElement('div');
  hp.className = 'hp';
  e.appendChild(hp);
  return e;
}
function releaseEnemyEl(el) { el.remove(); enemyPool.push(el); }

function getBeamEl() {
  const el = beamPool.pop();
  if (el) return el;
  const b = document.createElement('div');
  b.className = 'beam';
  return b;
}
function releaseBeamEl(el) { el.remove(); beamPool.push(el); }

/* (8) ---------- 配列 ---------- */
/** enemy = { el,type,x,y,vx,vy,speed,hp,maxHp,reward,t,swayAmp,swayFreq,dead } */
const enemies = [];

/* (9) ---------- スポーン（右端内側・高さランダム。TTIログ） ---------- */
function spawnEnemy(type = pickEnemyType()) {
  if (!laneRect) measureRects();
  const t = ENEMY_TYPES[type];
  const el = getEnemyEl();
  laneEl.appendChild(el);

  const startX = laneRect.width - 60 - Math.random() * 40;
  const startY = Math.max(16, Math.min(
    laneRect.height - 16,
    laneRect.height * (0.10 + 0.80 * Math.random())
  ));

  // lane座標の⚡中心（画面→lane 変換）
  const sc = centerScreen(spiritEl); // 画面
  const sx = sc.x - laneRect.left;   // lane
  const sy = sc.y - laneRect.top;

  const dist0 = Math.hypot(sx - startX, sy - startY);
  const tti0  = dist0 / t.speed;

  el.style.transform = `translate(${startX}px, ${startY}px)`;
  el.querySelector('.hp').style.width = '100%';
  el.setAttribute('data-hp', t.hp);

  enemies.push({
    el, type,
    x: startX, y: startY,
    vx: 0, vy: 0,
    speed: t.speed,
    hp: t.hp, maxHp: t.hp,
    reward: t.reward,
    t: 0,
    swayAmp: 6 + Math.random()*10,
    swayFreq: 1.0 + Math.random()*0.8,
    dead: false
  });

  addLog(`敵出現：${type.toUpperCase()}（dist≈${dist0|0}px / v=${t.speed}px/s → TTI≈${tti0.toFixed(2)}s）`, 'dim');
}

/* (10) ---------- スポーン間隔 ---------- */
let spawnTimer = 0;
function nextSpawnDelay() {
  const base = 1100; // ms
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return base + jitter;
}
let spawnDelay = nextSpawnDelay();

/* (11) ---------- 画面座標ヘルパ（中心） ---------- */
function centerScreen(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2 };
}
function getSpiritCenter() { return centerScreen(spiritEl); }
function getEnemyCenter(e) { return centerScreen(e.el); }

/* (12) ---------- ビーム演出 ---------- */
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

/* (13) ---------- 攻撃（連鎖） ---------- */
function dist2(ax, ay, bx, by) { const dx=ax-bx, dy=ay-by; return dx*dx + dy*dy; }

function tryAttack(dt) {
  lightning.timer -= dt;
  if (lightning.timer > 0) return;

  // 精霊の中心（画面→lane）
  const sc = getSpiritCenter();
  const sx = sc.x - laneRect.left;
  const sy = sc.y - laneRect.top;

  const r2 = lightning.range * lightning.range;

  // 射程内ターゲット
  const cand = [];
  for (const e of enemies) {
    if (e.dead) continue;
    const d2 = dist2(sx, sy, e.x, e.y);
    if (d2 <= r2) cand.push({ e, d2 });
  }
  if (!cand.length) return;

  cand.sort((a,b)=>a.d2 - b.d2);
  const maxHits = Math.min(lightning.chainCount + 1, cand.length);

  const used = new Set();
  let dmg = lightning.baseDmg;
  let dealtTotal = 0;

  // 1本目（⚡->最初）
  const first = cand[0].e;
  spawnBeam(sx, sy, first.x, first.y);
  used.add(first);

  // 連鎖
  let prev = first;
  for (let hit = 0; hit < maxHits; hit++) {
    const target = (hit === 0) ? first : cand.find(o => !used.has(o.e))?.e;
    if (!target || target.dead) break;

    if (hit > 0) spawnBeam(prev.x, prev.y, target.x, target.y);

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

  // 撃破処理（transformに触れない死亡アニメ / deadフラグ）
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e.dead && e.hp <= 0) {
      e.dead = true;
      addLog(`撃破（kill）：${e.type}`, 'gain');
      e.el.classList.add('dead');
      gold += e.reward; goldEl.textContent = gold;
      setTimeout(() => releaseEnemyEl(e.el), 240);
      enemies.splice(i, 1);
    }
  }

  logAttack(used.size, dealtTotal);
  lightning.timer = lightning.cooldown;
}

/* (14) ---------- ループ（安定ステアリング＋円ヒット＋脱出保険） ---------- */
let last = performance.now();
let GAME_RUNNING = false;

function gameLoop(now = performance.now()) {
  let dt = (now - last) / 1000; last = now;
  dt = Math.min(dt, 0.033);

  // 毎フレーム最新のrect（モバイルのURLバー出し入れ対策）
  measureRects();

  if (!GAME_RUNNING) {
    requestAnimationFrame(gameLoop);
    return;
  }

  // 精霊（画面座標 & 表示）
  const sc = getSpiritCenter();
  dbgDot('dbg-spirit', sc.x, sc.y);

  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.dead) continue;
    e.t += dt;

    // laneの精霊中心（画面→lane）
    const sxLane = sc.x - laneRect.left;
    const syLane = sc.y - laneRect.top;

    // 目標方向（正規化）
    let dx = sxLane - e.x, dy = syLane - e.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;

    // ★速度は“直接設定”で暴走封じ（蛇行したければ下のsteer式へ）
    e.vx = dx * e.speed;
    e.vy = dy * e.speed;

    // サイン揺れ
    const sway = Math.sin(e.t * (2*Math.PI*e.swayFreq)) * e.swayAmp;

    // 位置更新
    e.x += e.vx * dt;
    e.y += (e.vy + sway * 0.8) * dt;

    // NaN保険
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) {
      addLog('座標エラーで敵を除去（NaN）', 'alert');
      releaseEnemyEl(e.el); enemies.splice(i,1); continue;
    }

    // DOM反映
    e.el.style.transform = `translate(${e.x}px, ${e.y}px)`;

    // 画面座標の中心（可視化）
    const ec = getEnemyCenter(e);
    dbgDot('dbg-enemy', ec.x, ec.y);

    // 円ヒット（画面座標）
    const dist = Math.hypot(sc.x - ec.x, sc.y - ec.y);
    if (dist <= (R_SPIRIT + R_ENEMY)) {
      addLog(`⚡命中：${e.type}`, 'alert');
      releaseEnemyEl(e.el);
      enemies.splice(i, 1);
      continue;
    }

    // 画面外保険（右も含めて四方）
    const outRight = e.x > laneRect.width + 80;
    const outLeft  = e.x < -80;
    const outUp    = e.y < -80;
    const outDown  = e.y > laneRect.height + 80;
    if (outRight || outLeft || outUp || outDown) {
      addLog(`突破（escape）：${e.type}`, 'alert');
      releaseEnemyEl(e.el);
      enemies.splice(i, 1);
      continue;
    }
  }

  // 攻撃
  tryAttack(dt);

  // スポーン
  spawnTimer += dt * 1000;
  if (spawnTimer >= spawnDelay) {
    spawnTimer = 0;
    spawnDelay = nextSpawnDelay();
    spawnEnemy();
  }

  requestAnimationFrame(gameLoop);
}

/* (15) ---------- スタート画面＆セーブ ---------- */
const SAVE_KEY = 'idleLightningSaveV1';
function saveGame() {
  const data = { ts: Date.now(), gold, diamonds };
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
}
function loadGame() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function hasSave() { return !!localStorage.getItem(SAVE_KEY); }

function showStartScreen() {
  if (hasSave()) {
    btnContinue.disabled = false;
    continueHintEl.textContent = '前回の続きから再開できます。';
  } else {
    btnContinue.disabled = true;
    continueHintEl.textContent = 'セーブデータがあれば「つづきから」が有効になります。';
  }
  startScreenEl?.setAttribute('aria-hidden', 'false');
  GAME_RUNNING = false;
}
function hideStartScreen() {
  startScreenEl?.setAttribute('aria-hidden', 'true');
  GAME_RUNNING = true;
  // スタート直後の小出現
  spawnTimer = 0;
  spawnDelay = nextSpawnDelay();
  setTimeout(() => spawnEnemy('swarm'), 300);
  setTimeout(() => spawnEnemy('runner'), 800);
  setTimeout(() => spawnEnemy('tank'), 1300);
}

// ボタン
btnNew?.addEventListener('click', () => {
  gold = 0; diamonds = 0;
  goldEl.textContent = gold; diaEl.textContent = diamonds;
  // 残存敵クリア
  for (let i = enemies.length - 1; i >= 0; i--) {
    releaseEnemyEl(enemies[i].el);
    enemies.splice(i,1);
  }
  saveGame();
  hideStartScreen();
});
btnContinue?.addEventListener('click', () => {
  const data = loadGame();
  if (data) {
    gold = data.gold ?? gold;
    diamonds = data.diamonds ?? diamonds;
    goldEl.textContent = gold; diaEl.textContent = diamonds;
  }
  hideStartScreen();
});
// オートセーブ
setInterval(() => { if (GAME_RUNNING) saveGame(); }, 5000);

/* (16) ---------- 初期化＆起動 ---------- */
function init() {
  measureRects();
  addLog('タイトル待機中：スタート画面で「はじめから／つづきから」を選んでください', 'dim');
  last = performance.now();
  requestAnimationFrame(gameLoop);
}
window.addEventListener('load', () => {
  init();
  showStartScreen();
});

/* ===== 備考 =====
- CSS側の .enemy.dead は transform に触らない（opacityのみ）にしてあることが前提。
- デバッグドットは DEBUG_DOTS=true でON（style.cssの .dbg-dot が必要）。
- もし“蛇行”を少し戻したければ、(14)の速度設定を以下に変更（軽いステア）：
    const steer = 0.15;
    e.vx = e.vx*(1-steer) + (dx*e.speed)*steer;
    e.vy = e.vy*(1-steer) + (dy*e.speed)*steer;
  その場合も vmaxクランプは不要（直接設定のままなら安定）。
*/