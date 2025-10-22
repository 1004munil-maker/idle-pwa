// =====================================================
// shared.js — セーブデータ管理 / 共通ユーティリティ（装備用）
// =====================================================

const SAVE_KEY = "idleLightningGearV1";

// ステート（初期値）
let state = {
  currency: { gold: 0, diamonds: 0 },
  inventory: [],                          // 装備品一覧
  equipped: { stone: null, ring: null },  // 装備中ID
  nextItemId: 1
};

// -------- 永続化 --------
function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) { console.warn("gear load failed", e); }
}
function saveNow() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch (e) { console.warn("gear save failed", e); }
}

// -------- State 操作 --------
function getState() { return state; }
function commit(mutator) {
  const next = mutator({ ...state, inventory: [...state.inventory], equipped: { ...state.equipped }, currency: { ...state.currency } });
  if (next) state = next;
  saveNow();
}

// -------- ID生成 --------
function nextItemId() { const id = state.nextItemId++; saveNow(); return id; }

// -------- インベントリ操作 --------
function addToInventory(item) { state.inventory.push(item); }
function removeFromInventoryByIds(ids) {
  const set = new Set(ids);
  state.inventory = state.inventory.filter(x => !set.has(x.id));
}

// -------- 通貨（ダイヤ） --------
function addDiamonds(v) {
  state.currency.diamonds = (state.currency.diamonds | 0) + Math.max(0, v | 0);
}
function spendDiamonds(v) {
  v |= 0;
  if ((state.currency.diamonds | 0) < v) return false;
  state.currency.diamonds -= v;
  return true;
}

// -------- 見た目（Tier色） --------
const tierStyle = {
  S: { color: "#fbbf24" }, // 金
  A: { color: "#60a5fa" }, // 青
  B: { color: "#22c55e" }, // 緑
  C: { color: "#a3a3a3" }, // グレー
  D: { color: "#374151" }  // 黒
};

// -------- ガチャ確率 --------
const GACHA_RATE = { S: 0.1, A: 1, B: 4.9, C: 14, D: 80 };

// -------- オプションロール範囲 --------
const ROLL_RANGES = {
  S: { picks: 3, critDmg:[20,50], atkPct:[10,20], autoMs:[50,100], skillCd:[5,15], special:true },
  A: { picks: 2, critDmg:[10,25], atkPct:[5,15],  autoMs:[40,80],  skillCd:[5,10], special:false },
  B: { picks: 2, critDmg:[5,15],  atkPct:[3,8],   autoMs:[20,60],  skillCd:[3,8],  special:false },
  C: { picks: 1, critDmg:[2,10],  atkPct:[1,5],   autoMs:[10,30],  skillCd:[1,5],  special:false },
  D: { picks: 1, critDmg:[1,5],   atkPct:[1,3],   autoMs:[5,15],   skillCd:[1,3],  special:false },
};

// -------- SFX（ダミーでOK） --------
const sfx = {
  gacha: ()=>console.log("🎲 gacha!"),
  equip: ()=>console.log("⚡ equip!"),
  fuse:  ()=>console.log("✨ fuse!"),
  dismantle: ()=>console.log("🔧 dismantle!"),
};

// 自動セーブガード（必要なら後で実装）
function installAutoSaveGuards(){}

// 初期ロード
load();

// Export
export {
  getState, commit, saveNow,
  addDiamonds, spendDiamonds, nextItemId,
  addToInventory, removeFromInventoryByIds,
  tierStyle, GACHA_RATE, ROLL_RANGES, sfx,
  installAutoSaveGuards
};