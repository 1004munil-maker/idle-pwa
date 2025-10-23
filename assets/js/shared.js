// =====================================================
// shared.js — 共通セーブ/装備ユーティリティ（ゲーム本体と完全連携）
// =====================================================

const KEY_MAIN = 'idleLightningSaveV64';   // ゲーム本体のセーブ（主）
const KEY_GEAR = 'idleLightningGearV1';    // 旧: 装備セーブ（従/レガシー）

// 呼び出し側と互換のローカル状態（UIはこれを見る）
let state = {
  currency: { gold: 0, diamonds: 0 },
  inventory: [],                          // 装備品一覧
  equipped: { stone: null, ring: null },  // 装備中ID（任意の構造でOK）
  nextItemId: 1
};

/* ---------------- 内部ヘルパ ---------------- */
function readJSON(key){
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeJSON(key, obj){
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch {}
}
function dispatchUpdated(detail){
  try { window.dispatchEvent(new CustomEvent('sharedsave:updated', { detail })); } catch {}
}

/* ---------------- MAIN(saveV64) <-> GEAR(v1) マージ方針 ----------------
 * - diamonds は MAIN を“主”。ただし GEAR により大きい値があれば採用（片道移行）。
 * - 装備データは MAIN.save 内に { gear:{ inventory, equipped, nextItemId } } として保存。
 * - 旧 GEAR キーにもミラーを書き続ける（古い画面/コードがあっても壊れない）。
 * --------------------------------------------------------------------- */
function mergeSources(){
  const main = readJSON(KEY_MAIN) || {};
  const gear = readJSON(KEY_GEAR) || null;

  // diamonds
  const mainDia = Number(main.diamonds ?? 0) | 0;
  const gearDia = Number(gear?.currency?.diamonds ?? 0) | 0;
  const diamonds = Math.max(mainDia, gearDia);

  // gear payload
  const mainGear = main.gear || {};
  const invFromMain = Array.isArray(mainGear.inventory) ? mainGear.inventory : null;
  const eqFromMain  = mainGear.equipped || null;
  const idFromMain  = Number(mainGear.nextItemId) || null;

  const inv = invFromMain ?? (Array.isArray(gear?.inventory) ? gear.inventory : []);
  const eq  = eqFromMain  ?? (gear?.equipped || { stone:null, ring:null });
  let nextId = idFromMain ?? Number(gear?.nextItemId) || 1;

  // nextItemId が欠けてたらインベントリから復元
  if (!nextId && inv.length){
    nextId = 1 + inv.reduce((m, x) => Math.max(m, Number(x?.id)||0), 0);
  }

  // gold は MAIN を尊重（なければ 0）
  const gold = Number(main.gold ?? 0) | 0;

  // ローカル state を更新（UI用の表現）
  state.currency.gold = gold;
  state.currency.diamonds = diamonds;
  state.inventory = inv;
  state.equipped  = eq;
  state.nextItemId = nextId;

  // MAIN に反映（gear ブロックを持たせる）
  const mainNext = { ...main, diamonds };
  mainNext.gear = {
    inventory: inv,
    equipped:  eq,
    nextItemId: nextId
  };
  writeJSON(KEY_MAIN, mainNext);

  // レガシー GEAR へもミラー（壊さないため）
  const gearNext = {
    currency: { gold, diamonds },
    inventory: inv,
    equipped: eq,
    nextItemId: nextId
  };
  writeJSON(KEY_GEAR, gearNext);

  dispatchUpdated({ main: mainNext, gear: gearNext });
  return mainNext;
}

/* ---------------- パブリックAPI（呼び出し側そのまま使える） ---------------- */
function load(){
  // MAIN/GEAR をマージして state を最新化
  mergeSources();
}
function saveNow(){
  // state から MAIN/GEAR を両方更新
  const main = readJSON(KEY_MAIN) || {};
  const gold = Number(state.currency.gold || 0) | 0;
  const diamonds = Number(state.currency.diamonds || 0) | 0;

  const mainNext = {
    ...main,
    gold,
    diamonds,
    gear: {
      inventory: state.inventory,
      equipped:  state.equipped,
      nextItemId: state.nextItemId
    }
  };
  writeJSON(KEY_MAIN, mainNext);

  const gearNext = {
    currency: { gold, diamonds },
    inventory: state.inventory,
    equipped:  state.equipped,
    nextItemId: state.nextItemId
  };
  writeJSON(KEY_GEAR, gearNext);

  dispatchUpdated({ main: mainNext, gear: gearNext });
}

function getState(){ return state; }
function commit(mutator){
  const draft = {
    ...state,
    currency: { ...state.currency },
    equipped: { ...state.equipped },
    inventory: state.inventory.map(x => ({...x}))
  };
  const next = mutator(draft) || draft;
  state = next;
  saveNow();
}

/* ---- diamonds ---- */
function addDiamonds(v){
  v = Number(v) || 0;
  if (v <= 0) return;
  state.currency.diamonds = (Number(state.currency.diamonds)||0) + v;
  saveNow();
}
function spendDiamonds(v){
  v = Number(v) || 0;
  const have = Number(state.currency.diamonds)||0;
  if (v <= 0 || have < v) return false;
  state.currency.diamonds = have - v;
  saveNow();
  return true;
}

/* ---- inventory 操作 ---- */
function addToInventory(item){ state.inventory.push(item); saveNow(); }
function removeFromInventoryByIds(ids){
  const set = new Set(ids);
  state.inventory = state.inventory.filter(x => !set.has(x.id));
  saveNow();
}

/* ---- ID/コード ---- */
function nextItemId(){
  const id = Number(state.nextItemId)||1;
  state.nextItemId = id + 1;
  saveNow();
  return id;
}
function makeCode(len=8){
  const s = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return s.slice(0, len).toUpperCase();
}

/* ---- 見た目（Tier色） ---- */
const tierStyle = {
  S: { color: "#fbbf24" }, // 金
  A: { color: "#60a5fa" }, // 青
  B: { color: "#22c55e" }, // 緑
  C: { color: "#a3a3a3" }, // グレー
  D: { color: "#374151" }  // 黒
};

/* ---- ガチャ確率（%） ---- */
const GACHA_RATE = { S: 0.1, A: 1, B: 4.9, C: 14, D: 80 };

/* ---- オプションロール範囲 ---- */
const ROLL_RANGES = {
  S: { picks: 3, critDmg:[20,50], atkPct:[10,20], autoMs:[50,100], skillCd:[5,15], special:true },
  A: { picks: 2, critDmg:[10,25], atkPct:[5,15],  autoMs:[40,80],  skillCd:[5,10], special:false },
  B: { picks: 2, critDmg:[5,15],  atkPct:[3,8],   autoMs:[20,60],  skillCd:[3,8],  special:false },
  C: { picks: 1, critDmg:[2,10],  atkPct:[1,5],   autoMs:[10,30],  skillCd:[1,5],  special:false },
  D: { picks: 1, critDmg:[1,5],   atkPct:[1,3],   autoMs:[5,15],   skillCd:[1,3],  special:false },
};

/* ---- SFX（ダミー。必要なら別ファイルで上書き） ---- */
const sfx = {
  gacha: ()=>console.log("🎲 gacha!"),
  equip: ()=>console.log("⚡ equip!"),
  fuse:  ()=>console.log("✨ fuse!"),
  dismantle: ()=>console.log("🔧 dismantle!"),
  upg: ()=>console.log("🔧 upg"),
  success: ()=>console.log("✅ success"),
  failed: ()=>console.log("❌ failed"),
};

/* ---- オートセーブガード（必要なら拡張） ---- */
function installAutoSaveGuards(){ /* no-op */ }

/* ---- 外部から MAIN を読んだ時に差分取り込みたい場合 ---- */
function syncFromMain(){
  mergeSources(); // MAIN → state（GEARにもミラー）
}

/* 初期ロード（MAIN/GEAR をマージ） */
load();

/* ---- Export（既存の呼び出し箇所を壊さない） ---- */
export {
  getState, commit, saveNow, load, syncFromMain,
  addDiamonds, spendDiamonds, nextItemId, makeCode,
  addToInventory, removeFromInventoryByIds,
  tierStyle, GACHA_RATE, ROLL_RANGES, sfx,
  installAutoSaveGuards
};