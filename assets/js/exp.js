// assets/js/exp.js
// =====================================================
// EXP / Level module v1
// - addExp(amount, tag)
// - expFromKill(gs, enemyType)
// - expFromStageClear(gs)
// - getLevel(), getExp(), getNextReq()
// - onLevelUp(cb)
// HUD(任意): #levelChip, #expBar, #expLabel があれば更新
// 依存: shared.js（getState/commit/saveNow）
// =====================================================

import { getState, commit, saveNow } from './shared.js';

const LV_CAP = 200;               // 上限
const BASE_REQ = 20;              // Lv1→2必要EXP
const GROWTH = 1.12;              // 必要EXPの成長率

// レベルアップごとの基礎ATK上昇（後で調整OK）
const ATK_PER_LV = (lv) => (lv < 50 ? 1 : lv < 100 ? 2 : 3);

// 敵タイプごとの基礎EXP（好みで調整）
const KILL_EXP_BASE = {
  swarm:  4,   // 🦂
  runner: 5,   // 🦅
  tank:   9    // 🦏
};

// 係数（夜、章・面・階）
const NIGHT_K   = 1.30; // 夜はちょい増
const CHAP_K    = 0.12; // 章倍率
const STAGE_K   = 0.06; // 面倍率
const FLOOR_K   = 0.35; // 階倍率

// ステージクリア基本EXP
const CLEAR_EXP_BASE = 12;

const _listeners = { levelup: new Set() };

function reqFor(level){
  // LvN → N+1 の必要EXP
  return Math.floor(BASE_REQ * Math.pow(GROWTH, level - 1));
}

function ensure(){
  const st = getState();
  if (st.level == null) st.level = 1;
  if (st.exp   == null) st.exp   = 0;
  if (st.baseAtk == null) st.baseAtk = 1;
  return st;
}

function getLevel(){ return ensure().level|0; }
function getExp(){   return ensure().exp|0;   }
function getNextReq(){ return reqFor(getLevel()); }

function _applyHud(){
  const lvEl  = document.getElementById('levelChip');
  const barEl = document.getElementById('expBar');
  const lblEl = document.getElementById('expLabel');
  const lv = getLevel();
  const exp = getExp();
  const req = getNextReq();

  if (lvEl)  lvEl.textContent = `Lv ${lv}`;
  if (lblEl) lblEl.textContent = `${exp} / ${req}`;
  if (barEl) {
    const r = Math.max(0, Math.min(1, exp / Math.max(1, req)));
    barEl.style.width = (r*100).toFixed(1) + '%';
  }
}

function _gainLevel(n=1){
  let lvUp = 0;
  commit(s=>{
    s.level = (s.level|0) + n;
    // 攻撃力は「レベルと装備のみ」の方針 → レベルUP時にATK加算
    for (let i=0;i<n;i++){
      const lvNow = (s.level|0) - (n-1-i); // 上がったレベルに応じた加算
      s.baseAtk = (s.baseAtk|0) + ATK_PER_LV(lvNow);
    }
    return s;
  });
  saveNow();
  _applyHud();
  _listeners.levelup.forEach(fn=>{ try{ fn(getLevel()); }catch{} });
}

function addExp(amount, tag=''){
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  let overflow = 0;
  commit(s=>{
    ensure(); // ensure state exists
    if ((s.level|0) >= LV_CAP) return s; // 上限
    s.exp = (s.exp|0) + Math.floor(amount);
    // 繰り返しレベルアップ処理
    while ((s.level|0) < LV_CAP) {
      const need = reqFor(s.level|0);
      if ((s.exp|0) < need) break;
      s.exp -= need;
      s.level += 1;
      // baseAtkはここで上げず、後でまとめて _gainLevel で上げる
      overflow++;
    }
    return s;
  });
  if (overflow>0){
    _gainLevel(overflow);
  } else {
    saveNow();
    _applyHud();
  }
  return overflow;
}

// 倒した敵EXP（ゲームバランス用）
function expFromKill(gs, enemyType){
  const base = KILL_EXP_BASE[enemyType] ?? 4;
  const chapterK = 1 + (Math.max(0, (gs?.chapter|0) - 1) * CHAP_K);
  const stageK   = 1 + (Math.max(0, (gs?.stage|0)   - 1) * STAGE_K);
  const floorK   = 1 + (Math.max(0, (gs?.floor|0)   - 1) * FLOOR_K);
  const nightK   = (gs?.isNight ? NIGHT_K : 1);
  const v = Math.floor(base * chapterK * stageK * floorK * nightK);
  return Math.max(1, v);
}

// ステージクリアEXP
function expFromStageClear(gs){
  const chapterK = 1 + (Math.max(0, (gs?.chapter|0) - 1) * CHAP_K);
  const stageK   = 1 + (Math.max(0, (gs?.stage|0)   - 1) * STAGE_K);
  const floorK   = 1 + (Math.max(0, (gs?.floor|0)   - 1) * FLOOR_K);
  const nightK   = (gs?.isNight ? NIGHT_K : 1);
  return Math.max(1, Math.floor(CLEAR_EXP_BASE * chapterK * stageK * floorK * nightK));
}

function onLevelUp(cb){ _listeners.levelup.add(cb); return ()=> _listeners.levelup.delete(cb); }

// 手動HUD初期化（任意）
function initHud(){ _applyHud(); }

export default {
  getLevel, getExp, getNextReq,
  addExp, expFromKill, expFromStageClear,
  onLevelUp, initHud
};
