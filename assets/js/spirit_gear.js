// =====================================================
// spirit_gear.js — 精霊石＆指輪：在庫/ガチャ/強化/合成/分解/装着 v1.2
// 依存: shared.js（getState/commit/saveNow/…）
// =====================================================

import {
  getState, commit, saveNow,
  addDiamonds, spendDiamonds, nextItemId, makeCode,
  addToInventory, removeFromInventoryByIds,
  tierStyle, GACHA_RATE, ROLL_RANGES, sfx,
  installAutoSaveGuards
} from './shared.js';

/* 00) Audio unlock（PWA保険） */
const $ = sel => document.querySelector(sel);
const aUpg = $('#sfx-upg');
const aSuc = $('#sfx-success');
const aSucAlt = $('#sfx-success-alt');
const aFail = $('#sfx-failed');
const unlockBtn = $('#unlockAudioBtn');

let audioUnlocked = false;
async function unlockAudios(){
  const tryPrime = async (a)=>{
    if(!a) return;
    try { a.volume = Math.min(1, a.volume || 0.9); await a.play().catch(()=>{}); a.pause(); a.currentTime=0; } catch {}
  };
  await tryPrime(aUpg);
  await tryPrime(aSuc);
  await tryPrime(aSucAlt);
  await tryPrime(aFail);
  audioUnlocked = true;
  if (unlockBtn) unlockBtn.hidden = true;
}
function wireUnlock(){
  const once = ()=> unlockAudios();
  document.addEventListener('pointerdown', once, { once:true, passive:true });
  document.addEventListener('keydown',     once, { once:true });
  if (unlockBtn) { unlockBtn.hidden = false; unlockBtn.onclick = unlockAudios; }
}

/* 01) DOM参照 */
const invEl       = $('#inv');
const toastEl     = $('#toast');
const diaEl       = $('#dia');
const selCountEl  = $('#selCount');
const equippedBar = $('#equippedBar');

const btnSelectAll = $('#selectAllBtn');
const btnAutoDis   = $('#autoDismantleBtn');
const btnEnhance   = $('#enhanceBtn');
const btnEquip     = $('#equipBtn');
const btnG1        = $('#gacha1');
const btnG10       = $('#gacha10');
const btnFuse      = $('#fuseBtn');
const enhOverlay   = $('#enhOverlay');

let selected     = new Set();
let visibleItems = [];
let enhancing    = false;

/* 02) 2スロ（石/指輪）表示 */
function renderEquipped(){
  const st = getState();
  st.equipped ||= { stone:null, ring:null };

  const mkSlot = (slot, label) => {
    const id = st.equipped[slot];
    if(!id){
      return `
        <div class="slot" id="slot-${slot}" data-slot="${slot}" tabindex="0" role="button" aria-label="${label}スロット（空）">
          <div class="muted">${label}<br><small>（なし）</small></div>
        </div>`;
    }
    const it = st.inventory.find(x=> x.id===id);
    if(!it){
      // 参照切れ対策
      commit(s=>{ s.equipped[slot]=null; return s; }); saveNow();
      return mkSlot(slot, label);
    }
    const color = tierStyle[it.tier]?.color || '#ccc';
    const icon  = it.type==='石' ? '🪨' : '💍';
    return `
      <div class="slot filled" id="slot-${slot}" data-slot="${slot}" tabindex="0" role="button" aria-label="${label}スロット（装備中）" style="border-color:${color}">
        <div class="card equip" style="--rar:${color}">
          <div class="row space">
            <span class="badge" style="background:${color}">${it.tier}</span>
            <span class="tag">+${it.plus||0}</span>
          </div>
          <div class="row gap" style="margin-top:4px">
            <b class="wname">${icon} ${it.type}</b>
          </div>
          <button type="button" class="infoBtn bottom" data-id="${it.id}">?</button>
          <button type="button" class="unequip" data-slot="${slot}">外す</button>
        </div>
      </div>`;
  };

  equippedBar.innerHTML = mkSlot('stone','精霊石') + mkSlot('ring','指輪');

  // 外す
  equippedBar.querySelectorAll('button.unequip').forEach(btn=>{
    btn.onclick = ()=>{
      const slot = btn.dataset.slot;
      commit(s=>{ s.equipped ||= {stone:null, ring:null}; s.equipped[slot]=null; return s; });
      saveNow(); toast('装備を外しました','info',1000); refresh();
    };
  });
}

/* 03) 在庫レンダリング */
function refresh(){
  const st = getState();
  st.equipped ||= { stone:null, ring:null };
  if(diaEl) diaEl.textContent = st.currency?.diamonds|0;

  const eqIds = new Set([st.equipped.stone, st.equipped.ring].filter(Boolean));
  const order = {S:1,A:2,B:3,C:4,D:5};

  visibleItems = [...st.inventory]
    .filter(it => !eqIds.has(it.id))
    .sort((a,b)=>{
      if(order[a.tier]!==order[b.tier]) return order[a.tier]-order[b.tier];
      return b.id - a.id;
    });

  invEl.innerHTML = visibleItems.map(renderCard).join('');
  bindCardChecks();
  if(selCountEl) selCountEl.textContent = String(selected.size);
  renderEquipped();
}

function renderCard(it){
  const ts = tierStyle[it.tier];
  const border = ts?.color || '#ccc';
  const icon = it.type==='石' ? '🪨' : '💍';
  const checked = selected.has(it.id) ? 'checked' : '';
  return `
    <div class="card" data-id="${it.id}" style="--rar:${border}" tabindex="0">
      <div class="pickBox">
        <input type="checkbox" class="pick" data-id="${it.id}" ${checked} aria-label="select-${it.id}">
      </div>
      <div class="row space">
        <div class="row gap">
          <span class="badge" style="background:${border}">${it.tier}</span>
          <b class="wname">${icon} ${it.type}</b>
        </div>
        <span class="tag">+${it.plus||0}</span>
      </div>
      <div class="chips" style="margin-top:6px">${rollChips(it)}</div>
      <div class="code">#${it.code || '????'}</div>
      <button type="button" class="infoBtn bottom" data-id="${it.id}">?</button>
    </div>`;
}

function rollChips(it){
  const r = it.rolls||{};
  const chip = (txt)=> `<span class="tag" style="background:#111827">${txt}</span>`;
  const arr = [];
  if(r.critDmg) arr.push(chip(`クリダメ +${r.critDmg}%`));
  if(r.atkPct)  arr.push(chip(`攻撃 +${r.atkPct}%`));
  if(r.autoMs)  arr.push(chip(`自動 -${r.autoMs}ms`));
  if(r.skillCd) arr.push(chip(`CD -${r.skillCd}%`));
  if(r.special) arr.push(chip(`特性`));
  return arr.join(' ');
}

/* 04) 選択チェック */
function bindCardChecks(){
  invEl.querySelectorAll('input.pick').forEach(cb=>{
    cb.onchange = ()=>{
      const id = Number(cb.dataset.id);
      if(cb.checked) selected.add(id); else selected.delete(id);
      if(selCountEl) selCountEl.textContent = String(selected.size);
    };
  });
}

/* 05) トースト */
let toastTimer=null;
function toast(msg, kind='info', ms=1600){
  if(!toastEl){ alert(msg); return; }
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ toastEl.style.display='none'; }, ms);
}

/* 06) 情報バブル */
function closeAllInfo(){ document.querySelectorAll('.infoBubble').forEach(el=>el.remove());
  document.querySelectorAll('.infoBtn[data-open="1"]').forEach(b=> b.removeAttribute('data-open'));
}
function openInfo(btn, it){
  if(btn.getAttribute('data-open')==='1'){ closeAllInfo(); return; }
  closeAllInfo();
  const r = it.rolls||{};
  const bubble = document.createElement('div');
  bubble.className='infoBubble';
  bubble.innerHTML=`
    <div style="font-weight:900;margin-bottom:4px;">装備情報</div>
    <div><b>+${it.plus||0} ${it.tier} ${it.type}</b> / <small>#${it.code}</small></div>
    ${r.critDmg?`<div>クリダメ +${r.critDmg}%</div>`:''}
    ${r.atkPct? `<div>攻撃 +${r.atkPct}%</div>`:''}
    ${r.autoMs? `<div>自動 -${r.autoMs}ms</div>`:''}
    ${r.skillCd?`<div>スキルCD -${r.skillCd}%</div>`:''}
    ${r.special?`<div>特殊：あり</div>`:''}
  `;
  document.body.appendChild(bubble);
  const b = btn.getBoundingClientRect();
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  let x = b.left + b.width/2 - bw/2, y = b.bottom + 6;
  x = Math.max(6, Math.min(window.innerWidth - bw - 6, x));
  y = Math.max(6, Math.min(window.innerHeight - bh - 6, y));
  bubble.style.left = `${x}px`; bubble.style.top = `${y}px`;
  btn.setAttribute('data-open','1');
}
document.addEventListener('click', e=>{
  const btn = e.target.closest('.infoBtn');
  if(btn){
    e.preventDefault(); e.stopPropagation();
    const id = Number(btn.dataset.id);
    const st = getState();
    const it = st.inventory.find(x=> x.id===id);
    if(it) openInfo(btn, it);
    return;
  }
  if(!e.target.closest('.infoBubble')) closeAllInfo();
});

/* 07) ガチャ（石/指輪ランダム） */
const TYPES = ['石','指輪'];
const randInt = (a,b)=> Math.floor(Math.random()*(b-a+1))+a;
function shuffle(arr){ arr=arr.slice(); for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]];} return arr; }

function rollTier(){
  const r = Math.random()*100;
  if(r < GACHA_RATE.S) return 'S';
  if(r < GACHA_RATE.S + GACHA_RATE.A) return 'A';
  if(r < GACHA_RATE.S + GACHA_RATE.A + GACHA_RATE.B) return 'B';
  if(r < GACHA_RATE.S + GACHA_RATE.A + GACHA_RATE.B + GACHA_RATE.C) return 'C';
  return 'D';
}
function rollItem(){
  const tier = rollTier();
  const type = TYPES[Math.floor(Math.random()*TYPES.length)];
  const spec = ROLL_RANGES[tier];
  const chosen = shuffle(['critDmg','atkPct','autoMs','skillCd']).slice(0, spec.picks);
  const rolls = {};
  for(const k of chosen){ const [a,b] = spec[k]; rolls[k] = randInt(a,b); }
  if(spec.special) rolls.special = true;

  const id = nextItemId();
  const code = makeCode(8);
  const name = `(${tier})${type}`;
  const color = (tierStyle[tier]?.color) || '#ccc';
  return { id, type, tier, name, color, rolls, plus:0, count:1, code };
}
function gacha(n){
  const cost = 10*n;
  if(!spendDiamonds(cost)){ toast('💎が足りません','warn'); return; }
  saveNow();
  sfx.gacha?.();

  const pulled = [];
  for(let i=0;i<n;i++){ const it = rollItem(); addToInventory(it); pulled.push(it); }
  saveNow();

  const rare = pulled.filter(p=> ['S','A','B'].includes(p.tier));
  if(rare.length){
    const lines = rare.map(r=> `・${r.name} #${r.code}`).join('\n');
    toast(`🎉 入手！\n${lines}`,'ok',2200);
  }else{
    toast(`入手：${n}個`,'info',1200);
  }
  selected.clear(); refresh();
}

/* 08) 合成（10個：同Tier＆同Type） */
function fuse(){
  if(selected.size!==10){ toast('合成は10個選択してください','warn'); return; }
  const st = getState();
  const pick = [...selected].map(id=> st.inventory.find(x=> x.id===id)).filter(Boolean);
  if(pick.length!==10){ toast('選択が不正です','warn'); return; }
  const t0 = pick[0].tier, ty0 = pick[0].type;
  if(!pick.every(p=> p.tier===t0 && p.type===ty0)){ toast('同Tier/同種のみ','warn'); return; }

  const ladder = ['D','C','B','A','S'];
  const idx = ladder.indexOf(t0);
  if(idx<0 || idx===ladder.length-1){ toast('これ以上合成不可','warn'); return; }

  const ok = Math.random() < 0.3;
  sfx.fuse?.();
  removeFromInventoryByIds(pick.map(p=> p.id));
  saveNow();

  if(ok){
    const up = rollItem();
    up.tier = ladder[idx+1]; up.name = `(${up.tier})${ty0}`; up.type = ty0;
    addToInventory(up); saveNow();
    toast(`✅ 合成成功！ ${up.name} #${up.code}`,'ok',1800);
  }else{
    toast('❌ 合成失敗…（素材は消失）','warn',1600);
  }
  selected.clear(); refresh();
}

/* 09) 分解（選択 -> ダイヤ） */
const DISMANTLE_DIAMONDS = {
  D:[0,1,2], C:[20,10,0], B:[100,80,30], A:[300,200,100], S:[5000,2000,1000],
};
function dismantleSelected(){
  if(selected.size===0){ toast('分解する装備を選択してください','warn'); return; }
  const st = getState();
  const picks = [...selected].map(id=> st.inventory.find(x=> x.id===id)).filter(Boolean);
  let refund = 0;
  for(const it of picks){
    const table = DISMANTLE_DIAMONDS[it.tier] || [0];
    refund += (table[Math.floor(Math.random()*table.length)]|0);
  }
  removeFromInventoryByIds(picks.map(p=> p.id));
  if(refund>0) addDiamonds(refund);
  saveNow();
  sfx.dismantle?.();
  toast(`🔧 分解：+${refund}💎`, refund>0?'ok':'info', 1600);
  selected.clear(); refresh();
}

/* 10) 強化（0.9^next、+5以降は失敗時40%で破壊） */
const ENH_BASE = { D:5, C:10, B:15, A:20, S:30 };
const ENH_INC  = { D:5, C:5,  B:10, A:10, S:10 };
const BREAK_AFTER_PLUS = 5; // ★ ここから破壊モード
const BREAK_RATE_ON_FAIL = 0.40;

function enhCost(it){ return (ENH_BASE[it.tier]||10) + (ENH_INC[it.tier]||5)*(it.enhCount|0); }
function enhSuccP(nextPlus){ return Math.pow(0.9, nextPlus); } // 90%,81%,72.9%...

function formatPct(v, digits=1){
  return (v*100).toFixed(digits).replace(/\.0+$/,'') + '%';
}

function confirmBox(html){
  return new Promise(res=>{
    const w=document.createElement('div'); w.className='modal-wrap';
    const b=document.createElement('div'); b.className='modal';
    b.innerHTML=`<div class="title">強化の確認</div><div class="body">${html}</div>
    <div class="row r"><button id="no" class="btn ghost">いいえ</button>
    <button id="yes" class="btn accent">はい</button></div>`;
    w.appendChild(b); document.body.appendChild(w);
    b.querySelector('#no').onclick=()=>{document.body.removeChild(w);res(false)};
    b.querySelector('#yes').onclick=()=>{document.body.removeChild(w);res(true)};
  });
}

function setBusy(b){ ['gacha1','gacha10','fuseBtn','equipBtn','selectAllBtn','autoDismantleBtn','enhanceBtn']
  .forEach(id=>{ const el=document.getElementById(id); if(el) el.disabled=!!b; }); }

function animateFlash(cardEl, on){
  if(!cardEl) return;
  if(on){
    cardEl.classList.add('enh-flash');
  }else{
    cardEl.classList.remove('enh-flash');
  }
}

async function enhance(){
  if(enhancing) return;
  if(selected.size!==1){ toast('強化対象を1つ選択してください','warn'); return; }
  const id = [...selected][0];
  const st = getState();
  const it = st.inventory.find(x=> x.id===id);
  if(!it){ toast('選択が不正です','warn'); return; }

  const next = (it.plus|0)+1;
  const p = enhSuccP(next), failP = 1-p;
  const willBreakZone = (it.plus|0) >= BREAK_AFTER_PLUS;
  const overBreakP = willBreakZone ? failP*BREAK_RATE_ON_FAIL : 0;
  const cost = enhCost(it);

  const html = `
     対象：<b>${it.tier} ${it.type}</b>（<b>+${it.plus|0}</b> → <b>+${next}</b>）<br>
     成功率：<b>${formatPct(p,1)}</b> / 失敗率：${formatPct(failP,1)}<br>
     ${willBreakZone?`破壊率（失敗時）：<b>${formatPct(BREAK_RATE_ON_FAIL*100===40?0.40:BREAK_RATE_ON_FAIL,1)}</b><br>`:''}
     必要ダイヤ：<b>💎${cost}</b>
     ${willBreakZone?`<div class="warn">⚠ +${BREAK_AFTER_PLUS}以降：失敗時<b>40%</b>で破壊</div>`:''}
  `;
  const ok = await confirmBox(html);
  if(!ok) return;

  if(!spendDiamonds(cost)){ toast('💎が足りません','warn'); return; }
  saveNow(); if(diaEl) diaEl.textContent = getState().currency.diamonds|0;

  const cardEl = invEl?.querySelector(`.card[data-id="${id}"]`);
  enhancing=true; setBusy(true);

  // 許可中… 4秒 + フラッシュ + upg.mp3
  enhOverlay.hidden = false;
  animateFlash(cardEl, true);
  if (audioUnlocked) try{ aUpg.currentTime=0; aUpg.play(); }catch{}

  await new Promise(r=> setTimeout(r, 4000)); // 4秒待機
  // 2秒無音待ち
  await new Promise(r=> setTimeout(r, 2000));

  // 判定
  let success=false, broke=false;
  commit(s=>{
    const x = s.inventory.find(v=> v.id===id);
    if(!x) return s;
    x.enhCount = (x.enhCount|0)+1;
    success = Math.random()<p;
    if(success){ x.plus=(x.plus|0)+1; }
    else if((x.plus|0)>=BREAK_AFTER_PLUS && Math.random()<BREAK_RATE_ON_FAIL){
      broke=true;
      if(s.equipped?.stone===id) s.equipped.stone=null;
      if(s.equipped?.ring===id)  s.equipped.ring=null;
      const idx = s.inventory.findIndex(v=> v.id===id);
      if(idx>=0) s.inventory.splice(idx,1);
    }
    return s;
  });
  saveNow();

  enhOverlay.hidden = true;
  animateFlash(cardEl, false);

  if(success){
    toast(`✨ 強化成功：+${next-1} → +${next}`,'ok',1600);
    if (audioUnlocked) {
      try { (aSuc?.src && !aSuc.error) ? aSuc.play() : aSucAlt.play(); } catch {}
    }
  }else if(broke){
    toast('💥 強化失敗：装備破壊','warn',2000);
    if (audioUnlocked) try{ aFail.currentTime=0; aFail.play(); }catch{}
  }else{
    toast('❌ 強化失敗','warn',1500);
    if (audioUnlocked) try{ aFail.currentTime=0; aFail.play(); }catch{}
  }

  enhancing=false; setBusy(false); selected.clear(); refresh();
}

/* 11) 装着（2スロ自動判定） */
function animateFly(sourceCardEl, targetSlotEl, done){
  if(!sourceCardEl || !targetSlotEl){ done?.(); return; }
  const sRect = sourceCardEl.getBoundingClientRect();
  const tRect = targetSlotEl.getBoundingClientRect();
  const ghost = sourceCardEl.cloneNode(true);
  ghost.className='flyCard';
  Object.assign(ghost.style,{ left:`${sRect.left}px`, top:`${sRect.top}px`, width:`${sRect.width}px`, height:`${sRect.height}px` });
  document.body.appendChild(ghost);
  const dx = (tRect.left+tRect.width/2) - (sRect.left+sRect.width/2);
  const dy = (tRect.top+tRect.height/2)  - (sRect.top+sRect.height/2);
  const scale = Math.max(0.7, Math.min(1, (tRect.width/sRect.width)*0.9));
  requestAnimationFrame(()=>{ ghost.style.transform=`translate(${dx}px,${dy}px) scale(${scale})`; ghost.style.opacity='0.2'; });
  setTimeout(()=>{ ghost.remove(); done?.(); }, 360);
}

function equipSelected(){
  if(selected.size!==1){ toast('装着は1つだけ選択してください','warn'); return; }
  const id = [...selected][0];
  const st = getState();
  const it = st.inventory.find(x=> x.id===id);
  if(!it){ toast('選択が不正です','warn'); return; }

  const slot = (it.type==='石') ? 'stone' : 'ring';
  const targetEl = document.getElementById(`slot-${slot}`);
  const cardEl = invEl?.querySelector(`.card[data-id="${id}"]`);

  animateFly(cardEl, targetEl, ()=>{
    commit(s=>{
      s.equipped ||= { stone:null, ring:null };
      s.equipped[slot] = id;
      return s;
    });
    saveNow();
    sfx.equip?.();
    toast(`装着：(${it.tier})${it.type}`,'ok',1000);
    selected.clear(); refresh();
  });
}

/* 12) 全選択 */
function toggleSelectAll(){
  const ids = visibleItems.map(x=> x.id);
  const all = ids.every(id=> selected.has(id));
  if(all){ ids.forEach(id=> selected.delete(id)); } else { ids.forEach(id=> selected.add(id)); }
  invEl?.querySelectorAll('input.pick').forEach(cb=>{
    const id = Number(cb.dataset.id); cb.checked = selected.has(id);
  });
  if(selCountEl) selCountEl.textContent = String(selected.size);
}

/* 13) bind */
function bind(){
  btnG1 && (btnG1.onclick = ()=> gacha(1));
  btnG10 && (btnG10.onclick = ()=> gacha(10));
  btnFuse && (btnFuse.onclick = fuse);
  btnEnhance && (btnEnhance.onclick = enhance);
  btnEquip && (btnEquip.onclick = equipSelected);
  btnSelectAll && (btnSelectAll.onclick = toggleSelectAll);
  btnAutoDis && (btnAutoDis.onclick = dismantleSelected);

  // Info bubble close on ESC
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeAllInfo(); });
}

/* 14) init */
(function init(){
  installAutoSaveGuards();
  wireUnlock();
  bind();
  refresh();
})();