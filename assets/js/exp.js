// assets/js/exp.js
// シンプルなレベル制（保存・UI更新・多重レベルアップ対応）
// - reqExp(lv): そのレベル → 次レベルに必要な経験値
// - Kill/Clear の付与は game.js 側で呼ばれる（Exp.addExp）
// - レベルアップ時は基礎ATK(=雷baseDmg)を +1、ログ表示
// - ★Fix: ロード/初期化時に need を必ず再計算＆残余EXPで即時レベルアップ（式変更や古いデータに強い）
// - ★Fix: UI更新は要素ごとに個別更新（どれか欠けても他は更新される）

(function(){
  const SAVE_KEY = 'idleLightningExpV1';

  // ---- UI参照（init前は未確定なので後で取り直すことがある）----
  const ui = {
    lvChip:  document.getElementById('levelChip'),
    bar:     document.getElementById('expBar'),
    label:   document.getElementById('expLabel'),
  };

  // 必要経験値カーブ：Lv1→20、以降 1.25^(lv-1)
  function reqExp(lv){
    const L = Math.max(1, lv|0);
    return Math.max(1, Math.floor(20 * Math.pow(1.25, L - 1)));
  }

  // ---- state ----
  let st = safeLoad() || { lv:1, exp:0, need:reqExp(1) };
  let game = null;

  function safeLoad(){
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      // 古いデータに強いように数値化＆欠損補完
      const lv  = toInt(o.lv,  1);
      const exp = toInt(o.exp, 0);
      // ★need は保存値を信用しない：必ず現在式で再計算
      const need = reqExp(lv);
      return { lv, exp, need };
    } catch { return null; }
  }
  function toInt(v, def){ v = Number(v); return Number.isFinite(v) ? Math.floor(v) : def; }

  function save(){
    localStorage.setItem(SAVE_KEY, JSON.stringify(st));
  }

  // ---- UI更新（要素ごとに個別更新）----
  function refreshUI(){
    if (!ui.lvChip || !ui.bar || !ui.label) {
      // どれか未取得なら取り直しを試みる
      ui.lvChip = ui.lvChip || document.getElementById('levelChip');
      ui.bar    = ui.bar    || document.getElementById('expBar');
      ui.label  = ui.label  || document.getElementById('expLabel');
    }
    if (ui.lvChip) ui.lvChip.textContent = `Lv ${st.lv}`;
    if (ui.bar) {
      const pct = Math.max(0, Math.min(1, st.exp / st.need));
      ui.bar.style.width = (pct * 100).toFixed(1) + '%';
    }
    if (ui.label) ui.label.textContent = `${st.exp} / ${st.need}`;
  }

  function levelUpTimes(times){
    if (!times || !game) return;
    if (game.lightning && typeof game.setBaseDmg === 'function') {
      game.setBaseDmg((game.lightning.baseDmg|0) + times);
    }
    game.addLog(`⬆ レベルアップ！ Lv ${st.lv - times} → Lv ${st.lv}（ATK +${times}）`, 'gain');
  }

  function consumeLevelUpsIfNeeded(){
    // 連続レベルアップ対応（残余EXPがある限り回す）
    let upCount = 0;
    while (st.exp >= st.need) {
      st.exp -= st.need;
      st.lv++;
      st.need = reqExp(st.lv);    // ★毎回最新式で再計算
      upCount++;
      if (upCount > 1000) break;  // セーフガード
    }
    if (upCount > 0) levelUpTimes(upCount);
  }

  function addExp(v, why='misc'){
    v = Math.max(0, Math.floor(v));
    if (!v) return;
    st.exp += v;
    consumeLevelUpsIfNeeded();
    save(); refreshUI();
  }

  // 公開API
  window.Exp = {
    init(g){
      game = g;

      // DOMがまだなら取り直す
      ui.lvChip = document.getElementById('levelChip');
      ui.bar    = document.getElementById('expBar');
      ui.label  = document.getElementById('expLabel');

      // ★ロード時マイグレーション：need 再計算＆余剰EXP消化
      st.need = reqExp(st.lv);
      consumeLevelUpsIfNeeded();

      save();        // 最新式へ保存更新
      refreshUI();
    },
    addExp,
    getLevel: ()=> st.lv,
    getExp:   ()=> st.exp,
    getNeed:  ()=> st.need,

    // 参考：game.js からの式置き換え用ヘルパ（未使用でもOK）
    expFromKill(gs, type){
      const base = {swarm:1, runner:2, tank:6}[type]||1;
      const chap = 1 + (gs.chapter-1)*0.25;
      const night= gs.isNight?1.5:1;
      return Math.round(base * chap * night);
    },
    expFromStageClear(gs){
      return 10 + (gs.chapter-1)*5 + (gs.stage===10?15:0);
    },

    // デバッグ（必要ならコンソールから）
    _debugReset(){ st = { lv:1, exp:0, need:reqExp(1) }; save(); refreshUI(); }
  };

  // 初期描画（init前でもバーは表示される）
  refreshUI();
})();