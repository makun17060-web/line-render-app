(function(){
  const $ = (sel)=>document.querySelector(sel);
  const show = (el, data)=>{ el.hidden=false; el.textContent = typeof data==='string' ? data : JSON.stringify(data,null,2); };
  const auth = ()=>({ 'Authorization':'Bearer ' + (($('#token')?.value)||'').trim(), 'Content-Type':'application/json' });

  // ===== 認証・状態 =====
  $('#btnPing').onclick = async ()=>{
    try{
      const r = await fetch('/api/admin/ping', { headers: auth() });
      const j = await r.json();
      alert(j.ok ? 'OK' : ('NG: '+(j.error||'')));
    }catch(e){ alert('ERR '+e); }
  };
  $('#btnHealth').onclick = async ()=>{
    try{
      const r = await fetch('/api/health');
      show($('#healthOut'), await r.json());
    }catch(e){ show($('#healthOut'), String(e)); }
  };

  // ===== 商品取得 =====
  let products = [];
  async function loadProducts(){
    const r = await fetch('/api/admin/products', { headers: auth() });
    const j = await r.json();
    if (!j.ok) throw new Error('取得失敗: '+(j.error||''));
    products = j.items||[];
    $('#prodCount').textContent = `取得 ${products.length} 件`;
    renderProdGrid();
  }
  $('#btnLoadProducts').onclick = ()=> loadProducts().catch(err=>alert(err.message||err));

  // ===== 画像ドラッグ＆ドロップUI =====
  function renderProdGrid(){
    const grid = $('#prodGrid');
    if (!grid) return;
    grid.innerHTML = '';
    for (const p of products){
      const div = document.createElement('div');
      div.className = 'pitem';
      div.innerHTML = `
        <h3>${escapeHtml(p.name)} <span class="mini">(${escapeHtml(p.id)})</span></h3>
        <div class="thumb">${p.image ? `<img src="${p.image}" alt="">` : `<span class="muted">画像なし</span>`}</div>
        <div class="drop" data-pid="${escapeAttr(p.id)}">ここに画像をドロップ<br><span class="muted mini">または下のボタンから選択</span></div>
        <div class="row">
          <input type="file" accept="image/*" data-pick="${escapeAttr(p.id)}" />
          <button class="secondary" data-refresh="${escapeAttr(p.id)}">再読込</button>
        </div>
      `;
      grid.appendChild(div);
    }
    // イベント付与
    grid.querySelectorAll('.drop').forEach(el=>{
      el.addEventListener('dragover', e=>{ e.preventDefault(); el.style.borderColor='#9fb1ff'; });
      el.addEventListener('dragleave', ()=>{ el.style.borderColor=''; });
      el.addEventListener('drop', async (e)=>{
        e.preventDefault();
        el.style.borderColor='';
        const pid = el.dataset.pid;
        const file = e.dataTransfer.files?.[0];
        if (!file) return;
        await uploadImage(pid, file);
      });
    });
    grid.querySelectorAll('input[type=file][data-pick]').forEach(inp=>{
      inp.addEventListener('change', async ()=>{
        const pid = inp.dataset.pick;
        const file = inp.files?.[0];
        if (!file) return;
        await uploadImage(pid, file);
        inp.value = '';
      });
    });
    grid.querySelectorAll('button[data-refresh]').forEach(btn=>{
      btn.addEventListener('click', ()=> renderProdGrid());
    });
  }

  async function uploadImage(productId, file){
    const t = ($('#token')?.value||'').trim();
    if(!t) { alert('ADMIN_API_TOKEN を入力してください'); return; }
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`/api/admin/upload-image?productId=${encodeURIComponent(productId)}`, {
      method:'POST',
      headers: { 'Authorization':'Bearer '+t },
      body: fd
    });
    // 401でHTMLが返ってきた場合のガード
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch(_) {
      throw new Error(`アップロード失敗（JSONでない応答）。認証/URLを確認してください。\n${text.slice(0,200)}`);
    }
    if (!j.ok) throw new Error('アップロード失敗: '+(j.error||''));
    // ローカル products を更新
    const idx = products.findIndex(x=>x.id===productId);
    if (idx>=0) products[idx] = { ...products[idx], image: j.url };
    renderProdGrid();
  }

  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
  function escapeAttr(s){ return escapeHtml(s).replace(/"/g,'&quot;'); }

  // ===== Flex 生成 =====
  function yen(n){ return Number(n||0).toLocaleString('ja-JP')+'円'; }
  function buildFlex(){
    const hideRaw = ($('#hideIds')?.value||'').split(',').map(s=>s.trim()).filter(Boolean);
    const visible = products.filter(p=>!hideRaw.includes(p.id));
    const bubbles = visible.map(p=>{
      const base = {
        type:'bubble',
        body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
          { type:'text', text:p.name, weight:'bold', size:'md', wrap:true },
          { type:'text', text:`価格：${yen(p.price)}　在庫：${p.stock??0}`, size:'sm', wrap:true },
          p.desc ? { type:'text', text:p.desc, size:'sm', wrap:true } : { type:'box', layout:'vertical', contents:[] }
        ]},
        footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
          { type:'button', style:'primary', action:{ type:'postback', label:'数量を選ぶ', data:`order_qty?id=${encodeURIComponent(p.id)}&qty=1` } }
        ]}
      };
      if (p.image){
        base.hero = { type:'image', url:p.image, size:'full', aspectRatio:'1:1', aspectMode:'cover' };
      }
      return base;
    });
    // その他
    bubbles.push({
      type:'bubble',
      body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
        { type:'text', text:'その他（自由入力）', weight:'bold', size:'md' },
        { type:'text', text:'商品名と個数だけ入力します。価格入力は不要です。', size:'sm', wrap:true }
      ]},
      footer:{ type:'box', layout:'vertical', spacing:'md', contents:[
        { type:'button', style:'primary', action:{ type:'postback', label:'商品名を入力する', data:'other_start' } },
        { type:'button', style:'secondary', action:{ type:'postback', label:'← 戻る', data:'order_back' } }
      ]}
    });
    return {
      type:'flex',
      altText: (($('#altText')?.value)||'商品一覧').slice(0,400),
      contents: bubbles.length===1 ? bubbles[0] : { type:'carousel', contents:bubbles }
    };
  }
  $('#btnBuildFlex').onclick = ()=>{
    if (!products.length) return alert('先に商品を取得してください');
    show($('#flexPreview'), buildFlex());
  };

  // ===== 配信（Flex） =====
  $('#btnSendFlex').onclick = async ()=>{
    if (!products.length) return alert('先に商品を取得してください');
    const payload = buildFlex();
    const ids = (($('#userIds')?.value)||'').split(',').map(s=>s.trim()).filter(Boolean);
    const url = ids.length ? '/api/admin/segment/send-flex' : '/api/admin/broadcast-flex';
    const body = ids.length ? { userIds: ids, altText: payload.altText, contents: payload.contents }
                            : { altText: payload.altText, contents: payload.contents };
    const r = await fetch(url, { method:'POST', headers: auth(), body: JSON.stringify(body) });
    const j = await r.json().catch(()=>({ ok:false, error:'JSON parse error' }));
    $('#sendFlexRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||'' ));
  };

  // ===== テキスト配信 =====
  $('#btnSendText').onclick = async ()=>{
    const msg = (($('#textMessage')?.value)||'').trim();
    if (!msg) return alert('本文が空です');
    const ids = (($('#textUserIds')?.value)||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (ids.length){
      const r = await fetch('/api/admin/segment/send', { method:'POST', headers: auth(), body: JSON.stringify({ userIds: ids, message: msg }) });
      const j = await r.json().catch(()=>({ ok:false, error:'JSON parse error' }));
      $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||'' ));
    } else {
      const r = await fetch('/api/admin/broadcast-flex', {
        method:'POST', headers: auth(),
        body: JSON.stringify({ altText:'テキスト', contents:{ type:'bubble', body:{ type:'box', layout:'vertical', contents:[{ type:'text', text: msg, wrap:true }] } } })
      });
      const j = await r.json().catch(()=>({ ok:false, error:'JSON parse error' }));
      $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||'' ));
    }
  };

  // ===== userId 収集 =====
  $('#btnActiveUsers').onclick = async ()=>{
    const r = await fetch('/api/admin/active-chatters?list=true', { headers: auth() });
    const j = await r.json();
    show($('#usersOut'), j);
  };

  // ===== メッセージログ =====
  async function loadLog(){
    const r = await fetch('/api/admin/messages?limit=200', { headers: auth() });
    const j = await r.json();
    show($('#logOut'), j);
  }
  $('#btnLoadLog').onclick = loadLog;

  let auto=false, timer=null;
  $('#btnAutoRefresh').onclick = ()=>{
    auto = !auto; $('#autoStatus').textContent = auto ? 'ON' : 'OFF';
    if (auto){ loadLog(); timer = setInterval(loadLog, 10000); } else { clearInterval(timer); }
  };

  // ===== userId 自動入力（URL/ローカル保存/LIFF/whoami） =====
  const USER_IDS_INPUT_SELECTOR = "#userIds";
  const TEXT_USER_IDS_INPUT_SELECTOR = "#textUserIds";
  const PARAM_NAMES = ["userId", "uid", "me"];
  const LS_KEY = "admin_user_ids";
  const setIfExists = (sel, v)=>{ const el=$(sel); if (el && v) el.value=v; };
  const saveLocal = (v)=>{ try{ localStorage.setItem(LS_KEY, v); }catch{} };
  const loadLocal = ()=>{ try{ return localStorage.getItem(LS_KEY)||""; }catch{ return ""; } };
  const getFromUrl = ()=>{
    const u = new URL(location.href);
    for(const key of PARAM_NAMES){
      if(u.searchParams.has(key)){
        const v = u.searchParams.get(key);
        if(key==="me" && (v==="1"||v==="true")) return "me";
        if(v) return v.trim();
      }
    }
    const hash = (u.hash||"").replace(/^#/,"");
    const parts = new URLSearchParams(hash);
    for(const key of PARAM_NAMES){
      if(parts.has(key)){
        const v = parts.get(key);
        if(key==="me" && (v==="1"||v==="true")) return "me";
        if(v) return v.trim();
      }
    }
    return "";
  };
  const applyUserIds = (ids)=>{
    setIfExists(USER_IDS_INPUT_SELECTOR, ids);
    setIfExists(TEXT_USER_IDS_INPUT_SELECTOR, ids);
    saveLocal(ids);
    const a=$('#sendFlexRes'); if(a&&ids) a.textContent = `userId 自動入力: ${ids}`;
    const b=$('#sendTextRes'); if(b&&ids) b.textContent = `userId 自動入力: ${ids}`;
  };
  const tryLiff = async ()=>{
    const liffId = document.body?.dataset?.liffId;
    if(!liffId) return "";
    try{
      if(typeof window.liff === "undefined"){
        await new Promise((resolve,reject)=>{
          const s=document.createElement("script"); s.src="https://static.line-scdn.net/liff/edge/2/sdk.js";
          s.onload=resolve; s.onerror=reject; document.head.appendChild(s);
        });
      }
      await liff.init({ liffId });
      if(!liff.isLoggedIn()){ liff.login({}); return ""; }
      try{ const prof = await liff.getProfile(); if(prof?.userId) return prof.userId; }catch{}
      try{ const tok = liff.getDecodedIDToken(); if(tok?.sub) return tok.sub; }catch{}
    }catch(e){ console.warn("LIFF 取得失敗:", e); }
    return "";
  };
  const tryWhoAmI = async ()=>{
    try{
      const r = await fetch("/api/admin/whoami", { credentials:"include" });
      if(!r.ok) return ""; const j = await r.json();
      if(j?.userId) return j.userId;
    }catch{}
    return "";
  };
  document.addEventListener("DOMContentLoaded", async ()=>{
    let candidate = getFromUrl();
    if(candidate){ applyUserIds(candidate==="me" ? "me" : candidate); return; }
    candidate = loadLocal();
    if(candidate){ applyUserIds(candidate); }
    const fromLiff = await tryLiff(); if(fromLiff){ applyUserIds(fromLiff); return; }
    const fromApi = await tryWhoAmI(); if(fromApi){ applyUserIds(fromApi); return; }
  });
  const hookInput = (sel)=>{ const el=$(sel); if(!el) return; el.addEventListener("input", ()=> saveLocal(el.value.trim())); };
  hookInput(USER_IDS_INPUT_SELECTOR); hookInput(TEXT_USER_IDS_INPUT_SELECTOR);
})();
