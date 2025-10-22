// assets/js/status.js
// ステータス強化（常時効果）: Crit / Speed / Range / Gold+
// - ゴールド支払いで強化、即時セーブ、即時反映
// - window.Status API を公開

(function(){
  const SAVE_KEY = 'idleLightningStatusV1';

  // 基準値＆上限
  const caps = {
    critMax: 0.70,       // 最終クリ率上限（基礎10%含む）
    spdMin:  0.15,       // 最小クールダウン(s)
    rangeMaxMul: 1.60,   // 射程最大倍率
    goldMaxMul:  3.00,   // ゴールド最大倍率（+200%）
  };
  const step = {
  crit:  0.001, // +0.5% / Lv
  spd:   0.010, // -10ms / Lv
  range: 0.01,  // +1% / Lv
  gold:  0.01,  // +1% / Lv
};
const costBase = { crit:15, spd:20, range:12, gold:18 };
const costK    = 1.12;

  // 状態
  let st = load() || {
    lvCrit: 0, lvSpd: 0, lvRange: 0, lvGold: 0,
    // キャッシュ表示用
    baseCooldown: 0.70, // 後で実測を反映する
  };

  function load(){
    try{ return JSON.parse(localStorage.getItem(SAVE_KEY)||''); }catch{ return null; }
  }
  function save(){
    localStorage.setItem(SAVE_KEY, JSON.stringify(st));
  }

  // ─────────────────────────────────────────────
  // 計算系（現在値）
  function critChance(){         // クリ率（基礎10%込み、上限70%）
    const v = 0.10 + st.lvCrit * step.crit;
    return Math.min(v, caps.critMax);
  }
  function cooldown(base){       // 実効CD（下限0.15s）
    const v = Math.max(caps.spdMin, base - st.lvSpd * step.spd);
    return v;
  }
  function rangeMul(){           // 射程倍率
    const v = 1 + st.lvRange * step.range;
    return Math.min(v, caps.rangeMaxMul);
  }
  function goldMul(){            // ゴールド倍率
    const v = 1 + st.lvGold * step.gold;
    return Math.min(v, caps.goldMaxMul);
  }

  function costOf(key){
    const lv = (key==='crit'? st.lvCrit : key==='spd'? st.lvSpd : key==='range'? st.lvRange : st.lvGold);
    return Math.floor(costBase[key] * Math.pow(costK, lv));
  }

  // ─────────────────────────────────────────────
  // UI（オーバーレイ生成）
  let wrap = null;
  function ensureUI(game){
    if(wrap) return;
    wrap = document.createElement('div');
    wrap.id = 'status-overlay';
    wrap.style.cssText = `
      position:fixed; inset:0; z-index:1000; display:none;
      background:rgba(10,12,16,.82); backdrop-filter: blur(6px);
      color:#e9eef6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    wrap.innerHTML = `
      <div style="max-width:520px; margin:48px auto; background:#121824; border:1px solid #29364a; border-radius:16px; padding:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <b style="font-size:18px;">ステータス強化</b>
          <button id="stClose" style="background:#263142;border:1px solid #3a4a5f;color:#cfe1ff;border-radius:10px;padding:6px 10px;cursor:pointer;">閉じる</button>
        </div>

        <div id="stRows" class="rows"></div>
        <div id="stHint" style="margin-top:8px; font-size:12px; opacity:.85;">支払い: ゴールド / 強化は即時保存</div>
      </div>
    `;
    document.body.appendChild(wrap);
    wrap.querySelector('#stClose').onclick = hide;
    const rows = wrap.querySelector('#stRows');

    const mkRow = (id, label, desc) => `
      <div class="row" data-key="${id}" style="display:grid; grid-template-columns: 1fr auto; gap:10px; align-items:center; padding:10px 0; border-top:1px solid #1b2532;">
        <div>
          <div style="font-weight:800">${label}</div>
          <div style="opacity:.8; font-size:12px">${desc}</div>
          <div style="margin-top:6px; display:flex; gap:8px; flex-wrap:wrap;">
            <span class="chip cur" style="padding:4px 8px; border:1px solid #2b3b51; border-radius:999px; font-size:12px;">現在: <b class="val">-</b></span>
            <span class="chip lv"  style="padding:4px 8px; border:1px solid #2b3b51; border-radius:999px; font-size:12px;">Lv: <b class="lvnum">0</b></span>
            <span class="chip cost"style="padding:4px 8px; border:1px solid #2b3b51; border-radius:999px; font-size:12px;">次コスト: <b class="c">-</b>G</span>
          </div>
        </div>
        <div>
          <button class="up" style="min-width:96px; padding:10px 12px; border-radius:12px; border:1px solid #40546c; background:linear-gradient(#2a3545,#1f2835); color:#e9eef6; cursor:pointer;">強化</button>
        </div>
      </div>
    `;

    rows.innerHTML =
      mkRow('crit',  'クリティカル率', '基礎10% 〜 上限70%（+0.1%/Lv）') +
      mkRow('spd',   '攻撃速度',      'CD -10ms/回（下限 150ms）') +
      mkRow('range', '射程距離',      '射程 +1%/回（最大 +60%）') +
      mkRow('gold',  'ゴールド獲得',  '獲得 +1%/回（最大 +200%）');

    // クリック
    rows.querySelectorAll('.row .up').forEach(btn=>{
      btn.onclick = () => {
        const key = btn.closest('.row').dataset.key;
        tryUpgrade(key, game);
      };
    });

    // 初回UI反映
    refreshUI(game);
  }

  function show(game){
    ensureUI(game);
    refreshUI(game);
    wrap.style.display = 'block';
  }
  function hide(){ if(wrap) wrap.style.display = 'none'; }

  function refreshUI(game){
    if(!wrap) return;
    const rows = wrap.querySelectorAll('.row');
    rows.forEach(row=>{
      const key = row.dataset.key;
      let curText = '-', lv = 0, maxed = false;

      if(key==='crit'){
        lv = st.lvCrit;
        curText = (critChance()*100).toFixed(1) + '%';
        maxed = critChance() >= caps.critMax - 1e-9;
      }else if(key==='spd'){
        lv = st.lvSpd;
        const eff = cooldown(st.baseCooldown);
        curText = Math.round(eff*1000) + 'ms';
        maxed = eff <= caps.spdMin + 1e-9;
      }else if(key==='range'){
        lv = st.lvRange;
        const mul = rangeMul();
        curText = '+' + Math.round((mul-1)*100) + '%';
        maxed = mul >= caps.rangeMaxMul - 1e-9;
      }else if(key==='gold'){
        lv = st.lvGold;
        const mul = goldMul();
        curText = '+' + Math.round((mul-1)*100) + '%';
        maxed = mul >= caps.goldMaxMul - 1e-9;
      }

      row.querySelector('.val').textContent = curText;
      row.querySelector('.lvnum').textContent = String(lv);

      const costSpan = row.querySelector('.c');
      const btn = row.querySelector('.up');

      if(maxed){
        costSpan.textContent = 'MAX';
        btn.disabled = true;
        btn.textContent = 'MAX LV';
      }else{
        const c = costOf(key);
        costSpan.textContent = String(c);
        btn.disabled = false;
        btn.textContent = '強化';
      }
    });
  }

  // 実行
  function tryUpgrade(key, game){
    // MAX判定
    if(key==='crit' && critChance() >= caps.critMax - 1e-9) return;
    if(key==='spd'  && cooldown(st.baseCooldown) <= caps.spdMin + 1e-9) return;
    if(key==='range'&& rangeMul() >= caps.rangeMaxMul - 1e-9) return;
    if(key==='gold' && goldMul()  >= caps.goldMaxMul - 1e-9) return;

    const cost = costOf(key);
    if(!game || !game.spendGold || !game.addLog){ alert('GameAPI未接続'); return; }
    if(!game.spendGold(cost)){ game.addLog('💰 ゴールドが足りません', 'alert'); return; }

    // レベル加算
    if(key==='crit') st.lvCrit++;
    if(key==='spd')  st.lvSpd++;
    if(key==='range')st.lvRange++;
    if(key==='gold') st.lvGold++;
    save();

    // ゲームへ反映
    applyToGame(game);
    refreshUI(game);
    game.addLog(`⚙️ ステータス強化：${labelOf(key)} をアップグレード`, 'gain');
  }

  function labelOf(key){
    return key==='crit'?'クリ率': key==='spd'?'攻撃速度': key==='range'?'射程': 'ゴールド';
  }

  // ─────────────────────────────────────────────
  // ゲーム反映（lightning へ反映 & 表示キャッシュ更新）
  function applyToGame(game){
    if(!game || !game.lightning) return;
    // base を把握（起動時・装備変更時に呼ぶ）
    if(typeof game.lightning.cooldown === 'number'){
      st.baseCooldown = game.lightning.cooldownBase ?? game.lightning.cooldown;
    }
    // 攻撃速度
    const base = game.lightning.cooldownBase ?? st.baseCooldown;
    const effCd = cooldown(base);
    game.lightning.cooldown = effCd;
    // 射程
    game.lightning.range = Math.round((game.lightning.baseRange ?? game.lightning.range) * rangeMul());
    // 保存
    save();
    // HUDの鎖枚数表示等は game 側に任せる
  }

  // ─────────────────────────────────────────────
  // 公開API
  window.Status = {
    init(game){
      // lightning の基準値を覚えて反映
      if(game?.lightning){
        if(game.lightning.cooldownBase==null) game.lightning.cooldownBase = game.lightning.cooldown;
        if(game.lightning.baseRange==null)    game.lightning.baseRange    = game.lightning.range;
      }
      ensureUI(game);
      applyToGame(game);
    },
    open(game){ show(game); },
    close(){ hide(); },
    // ゲーム側で参照する値
    getCritChance: ()=> critChance(),     // 0..1
    getCritMul:    ()=> 2.0,             // 2倍固定（必要なら変更）
    getGoldMul:    ()=> goldMul(),
    // 外部から再適用したい時（例：装備で base が変わった）
    applyToGame,
  };
})();