// assets/js/status.js vproto-02-fix1
// ステータス強化（常時効果）: Crit / Speed / Range / Gold+
// - ゴールド支払いで強化、即時セーブ、即時反映
// - window.Status API を公開
// - ❗修正点
//   * _inited フラグを init 内で true にする（多重初期化ガードのため）
//   * open() が初回でも必ず UI を生成できるように防御
//   * load() を安全化（空文字や壊れたJSONで例外を出さない）
//   * ダイアログ表示ロジックを強化（aria-hidden の適切化 / Esc / 背景クリックで閉じる）
//   * 旧環境で toLocaleString 周りの未定義を避ける防御

(function(){
  'use strict';

  const SAVE_KEY = 'idleLightningStatusV1';

  // 基準値＆上限
  const caps = {
    critMax: 0.60,       // 最終クリ率上限（基礎10%含む）
    spdMin:  0.15,       // 最小クールダウン(s)
    rangeMaxMul: 2.20,   // 射程最大倍率
    goldMaxMul:  3.00,   // ゴールド最大倍率（+200%）
  };
  const step = {
    crit:  0.0025, // +0.25% / Lv
    spd:   0.010, // -10ms / Lv
    range: 0.005,  // +1% / Lv
    gold:  0.05,  // +1% / Lv
  };
  const costBase = { crit:15, spd:20, range:10, gold:15 };
  const costK    = 1.13;

  // 状態
  let st = load() || { lvCrit:0, lvSpd:0, lvRange:0, lvGold:0, baseCooldown:0.70 };

  function load(){
    try{
      const s = localStorage.getItem(SAVE_KEY);
      if(!s) return null;
      const obj = JSON.parse(s);
      if(!obj || typeof obj !== 'object') return null;
      return obj;
    }catch{ return null; }
  }
  function save(){ try{ localStorage.setItem(SAVE_KEY, JSON.stringify(st)); }catch{} }

  // 計算系
  function critChance(){ return Math.min(0.10 + st.lvCrit * step.crit, caps.critMax); }
  function cooldown(base){ return Math.max(caps.spdMin, base - st.lvSpd * step.spd); }
  function rangeMul(){ return Math.min(1 + st.lvRange * step.range, caps.rangeMaxMul); }
  function goldMul(){  return Math.min(1 + st.lvGold  * step.gold,  caps.goldMaxMul ); }
  function costOf(key){
    const lv = (key==='crit'? st.lvCrit : key==='spd'? st.lvSpd : key==='range'? st.lvRange : st.lvGold);
    return Math.floor(costBase[key] * Math.pow(costK, lv));
  }
  function costSum(key, n){
    const lv0 = (key==='crit'? st.lvCrit : key==='spd'? st.lvSpd : key==='range'? st.lvRange : st.lvGold);
    let sum = 0;
    for(let i=0;i<n;i++){
      sum += Math.floor(costBase[key] * Math.pow(costK, lv0 + i));
    }
    return sum;
  }

  // UI
  let wrap = null;
  function ensureUI(game){
    if(wrap) return;
    wrap = document.createElement('div');
    wrap.id = 'status-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.cssText = [
      'position:fixed','inset:0','z-index:1000','display:none',
      'background:rgba(10,12,16,.82)','backdrop-filter:blur(6px)',
      'color:#e9eef6'
    ].join(';');

    const goldNowNum = Number(typeof game?.getGold === 'function' ? game.getGold() : 0) || 0;
    const goldNow = goldNowNum.toLocaleString();
    wrap.innerHTML = `
      <div style="max-width:560px; margin:0px auto; background:#121824; border:1px solid #29364a; border-radius:16px; padding:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <b style="font-size:18px;">ステータス強化</b>
            <span class="goldpill" style="padding:.15rem .5rem; border:1px solid rgba(255,215,0,.7); border-radius:999px; background:rgba(255,215,0,.08); color:#ffd86b;">💰 <b id="stGold">${goldNow}</b></span>
          </div>
          <button id="stClose" style="background:#263142;border:1px solid #3a4a5f;color:#cfe1ff;border-radius:10px;padding:6px 10px;cursor:pointer;">閉じる</button>
        </div>
        <div id="stRows" class="rows"></div>
        <div id="stHint" style="margin-top:8px; font-size:12px; opacity:.85;">支払い: ゴールド / 強化は即時保存（長押しで連続強化）</div>
      </div>`;
    document.body.appendChild(wrap);

    const closeBtn = wrap.querySelector('#stClose');
    if(closeBtn) closeBtn.addEventListener('click', hide, { passive:true });

    // 背景クリックで閉じる
    wrap.addEventListener('click', (ev)=>{ if(ev.target === wrap) hide(); });
    // Escで閉じる
    document.addEventListener('keydown', (ev)=>{ if(ev.key === 'Escape' && wrap && wrap.style.display === 'block') hide(); });

    const rows = wrap.querySelector('#stRows');
    const mkRow = (id, label, desc) => `
      <div class="row" data-key="${id}" style="display:grid; grid-template-columns: 1fr auto; gap:10px; align-items:center; padding:10px 0; border-top:1px solid #1b2532;">
        <div>
          <div style="font-weight:800">${label}</div>
          <div style="opacity:.8; font-size:12px">${desc}</div>
          <div style="margin-top:6px; display:flex; gap:8px; flex-wrap:wrap;">
            <span class="chip cur"  style="padding:4px 8px; border:1px solid #2b3b51; border-radius:999px; font-size:12px;">現在: <b class="val">-</b></span>
            <span class="chip lv"   style="padding:4px 8px; border:1px solid #2b3b51; border-radius:999px; font-size:12px;">Lv: <b class="lvnum">0</b></span>
            <span class="chip cost" style="padding:4px 8px; border:1px solid #2b3b51; border-radius:999px; font-size:12px;">次コスト: <b class="c">-</b>G</span>
            <span class="chip cost10" style="padding:4px 8px; border:1px solid #2b3b51; border-radius:999px; font-size:12px;">+10合計: <b class="c10">-</b>G</span>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="up1"  style="min-width:86px; padding:10px 12px; border-radius:12px; border:1px solid #40546c; background:linear-gradient(#2a3545,#1f2835); color:#e9eef6; cursor:pointer;">+1</button>
          <button class="up10" style="min-width:86px; padding:10px 12px; border-radius:12px; border:1px solid #6e4b30; background:linear-gradient(#46382a,#2d241a); color:#ffe0b1; cursor:pointer;">+10</button>
        </div>
      </div>`;
    rows.innerHTML =
      mkRow('crit',  'クリティカル率', '基礎10% 〜 上限60%（+0.25%/Lv）') +
      mkRow('spd',   '攻撃速度',      'CD -5ms/回（下限 150ms）') +
      mkRow('range', '射程距離',      '射程 +0.5%/回（最大 +120%）') +
      mkRow('gold',  'ゴールド獲得',  '獲得 +5%/回（最大 +1000%）');

    const bind = (sel, handler) => rows.querySelectorAll(sel).forEach(btn => btn.addEventListener('click', () => handler(btn.closest('.row').dataset.key)));
    const hold = (sel, handler) => rows.querySelectorAll(sel).forEach(btn => {
      let t; let run=false;
      const key = btn.closest('.row').dataset.key;
      const start = () => { if(run) return; run=true; handler(key); t=setInterval(()=>handler(key), 160); };
      const end   = () => { run=false; clearInterval(t); };
      btn.addEventListener('mousedown', start); btn.addEventListener('touchstart', start);
      ['mouseup','mouseleave','touchend','touchcancel','blur'].forEach(ev=>btn.addEventListener(ev, end));
    });

    bind('.up10', (key)=>tryUpgradeN(key, 10, game));
    hold('.up1',  (key)=>tryUpgradeN(key, 1,  game));

    refreshUI(game);
  }

  function show(game){
    ensureUI(game);
    refreshUI(game);
    wrap.style.display='block';
    wrap.setAttribute('aria-hidden','false');
  }
  function hide(){
    if(!wrap) return;
    wrap.style.display='none';
    wrap.setAttribute('aria-hidden','true');
  }
  function setGoldLabel(game){
    try{
      const num = Number(typeof game?.getGold === 'function' ? game.getGold() : 0) || 0;
      const el = wrap?.querySelector('#stGold');
      if(el) el.textContent = num.toLocaleString();
    }catch{}
  }

  function refreshUI(game){
    if(!wrap) return;
    setGoldLabel(game);
    const rows = wrap.querySelectorAll('.row');
    rows.forEach(row=>{
      const key = row.dataset.key;
      let curText = '-', lv = 0, maxed = false;

      if(key==='crit'){ lv = st.lvCrit; curText = (critChance()*100).toFixed(1) + '%'; maxed = critChance() >= caps.critMax - 1e-9; }
      else if(key==='spd'){ lv = st.lvSpd; const eff = cooldown(st.baseCooldown); curText = Math.round(eff*1000) + 'ms'; maxed = eff <= caps.spdMin + 1e-9; }
      else if(key==='range'){ lv = st.lvRange; const mul = rangeMul(); curText = '+' + Math.round((mul-1)*100) + '%'; maxed = mul >= caps.rangeMaxMul - 1e-9; }
      else if(key==='gold'){ lv = st.lvGold; const mul = goldMul(); curText = '+' + Math.round((mul-1)*100) + '%'; maxed = mul >= caps.goldMaxMul - 1e-9; }

      const valEl = row.querySelector('.val'); if(valEl) valEl.textContent = curText;
      const lvEl  = row.querySelector('.lvnum'); if(lvEl) lvEl.textContent = String(lv);
      const costSpan = row.querySelector('.c');       if(costSpan) costSpan.textContent = maxed ? 'MAX' : String(costOf(key));
      const cost10   = row.querySelector('.c10');     if(cost10)   cost10.textContent   = maxed ? '-'   : String(costSum(key, 10));
      const up1  = row.querySelector('.up1');  if(up1)  up1.disabled  = maxed;
      const up10 = row.querySelector('.up10'); if(up10) up10.disabled = maxed;
    });
  }

  function notEnoughToast(btn){
    if(!btn || !btn.parentElement) return;
    const t = document.createElement('div');
    t.textContent = 'ゴールドが足りません';
    t.style.cssText = 'position:absolute; right:0; top:-22px; padding:2px 6px; font-size:11px; border-radius:8px; background:#3a1f1f; color:#ffd0d0; border:1px solid #5c2c2c;';
    const host = btn.parentElement;
    const prevPos = host.style.position;
    if(getComputedStyle(host).position === 'static') host.style.position='relative';
    host.appendChild(t);
    setTimeout(()=>{
      t.remove();
      if(prevPos) host.style.position = prevPos;
    }, 1400);
  }

  function tryUpgradeN(key, n, game){
    // MAX判定
    const maxed = (key==='crit' && critChance() >= caps.critMax - 1e-9) ||
                  (key==='spd'  && cooldown(st.baseCooldown) <= caps.spdMin + 1e-9) ||
                  (key==='range'&& rangeMul() >= caps.rangeMaxMul - 1e-9) ||
                  (key==='gold' && goldMul()  >= caps.goldMaxMul - 1e-9);
    if(maxed) return;

    if(!game || typeof game.spendGold !== 'function' || typeof game.addLog !== 'function'){
      // GameAPI未接続でも UI は開けるようにしておく
      alert('GameAPI未接続：ゲームを開始してから再度お試しください。');
      return;
    }

    let remain = n;
    while(remain>0){
      const cost = costOf(key);
      if(!game.spendGold(cost)){
        const btnSel = `.row[data-key="${key}"] .up1`;
        notEnoughToast(wrap?.querySelector(btnSel));
        break;
      }
      if(key==='crit') st.lvCrit++; else if(key==='spd') st.lvSpd++; else if(key==='range') st.lvRange++; else st.lvGold++;
      save();
      applyToGame(game);
      remain--;
    }
    refreshUI(game);
    game.addLog(`⚙️ ステータス強化：${labelOf(key)} +${n-remain}`, 'gain');
    setGoldLabel(game);
  }

  function labelOf(key){ return key==='crit'?'クリ率': key==='spd'?'攻撃速度': key==='range'?'射程': 'ゴールド'; }

  function applyToGame(game){
    if(!game || !game.lightning) return;
    // ベース値キャプチャ
    if(typeof game.lightning.cooldown === 'number'){
      st.baseCooldown = game.lightning.cooldownBase ?? game.lightning.cooldown;
    }
    if(game.lightning.cooldownBase == null) game.lightning.cooldownBase = st.baseCooldown;
    if(game.lightning.baseRange    == null) game.lightning.baseRange    = game.lightning.range;

    // 反映
    const base = game.lightning.cooldownBase ?? st.baseCooldown;
    const effCd = cooldown(base);
    game.lightning.cooldown = effCd;
    game.lightning.range = Math.round((game.lightning.baseRange ?? game.lightning.range) * rangeMul());
    save();
  }

  // 公開API
  window.Status = {
    _inited:false,
    init(game){
      if(this._inited) return;
      if(game?.lightning){
        if(game.lightning.cooldownBase==null) game.lightning.cooldownBase = game.lightning.cooldown;
        if(game.lightning.baseRange==null)    game.lightning.baseRange    = game.lightning.range;
      }
      ensureUI(game);
      applyToGame(game);
      this._inited = true; // ← ここが今回の修正ポイント
    },
    open(game){
      // 初回でも必ず UI を生成して開く
      if(!this._inited) this.init(game);
      show(game);
    },
    close(){ hide(); },
    reset(){ st = { lvCrit:0, lvSpd:0, lvRange:0, lvGold:0, baseCooldown:0.70 }; save(); if(wrap) refreshUI(); },
    getCritChance: ()=> critChance(),
    getCritMul:    ()=> 2.0,
    getGoldMul:    ()=> goldMul(),
    applyToGame,
  };
})();