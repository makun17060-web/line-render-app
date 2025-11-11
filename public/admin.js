(function(){
  // ===== 共通ユーティリティ =====
  const $  = (sel)=>document.querySelector(sel);
  const show = (el, data)=>{ if(!el) return; el.hidden=false; el.textContent = typeof data==='string' ? data : JSON.stringify(data,null,2); };
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

  // ===== 商品取得 → Flex生成 =====
  let products = [];
  $('#btnLoadProducts').onclick = async ()=>{
    try{
      const r = await fetch('/api/admin/products', { headers: auth() });
      const j = await r.json();
      if (!j.ok) return alert('取得失敗: '+(j.error||''));
      products = j.items||[];
      $('#prodCount').textContent = `取得 ${products.length} 件`;
    }catch(e){ alert('ERR '+e.message); }
  };

  function yen(n){ return Number(n||0).toLocaleString('ja-JP')+'円'; }
  function qstr(obj){ return Object.entries(obj).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'); }

  function buildFlex(){
    const hideRaw = ($('#hideIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    const visible = products.filter(p=>!hideRaw.includes(p.id));

    const bubbles = visible.map(p=>({
      type:'bubble',
      body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
        { type:'text', text:p.name, weight:'bold', size:'md', wrap:true },
        { type:'text', text:`価格：${yen(p.price)}　在庫：${p.stock??0}`, size:'sm', wrap:true },
        p.desc ? { type:'text', text:p.desc, size:'sm', wrap:true } : { type:'box', layout:'vertical', contents:[] }
      ]},
      footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
        // ★ これが「数量を選ぶ」ポストバック（意味：数量選択画面へ遷移トリガー）
        { type:'button', style:'primary', action:{ type:'postback', label:'数量を選ぶ', data:`order_qty?${qstr({ id:p.id, qty:1 })}` } }
      ]}
    }));

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
      altText: ($('#altText').value||'商品一覧').slice(0,400),
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
    const ids = ($('#userIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    const url = ids.length ? '/api/admin/segment/send-flex' : '/api/admin/broadcast-flex';
    const body = ids.length ? { userIds: ids, altText: payload.altText, contents: payload.contents }
                            : { altText: payload.altText, contents: payload.contents };
    const r = await fetch(url, { method:'POST', headers: auth(), body: JSON.stringify(body) });
    const j = await r.json();
    $('#sendFlexRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
  };

  // ===== テキスト配信 =====
  $('#btnSendText').onclick = async ()=>{
    const msg = ($('#textMessage').value||'').trim();
    if (!msg) return alert('本文が空です');
    const ids = ($('#textUserIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (ids.length){
      const r = await fetch('/api/admin/segment/send', { method:'POST', headers: auth(), body: JSON.stringify({ userIds: ids, message: msg }) });
      const j = await r.json();
      $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));      
    } else {
      // テキストを Flex に包んで broadcast
      const r = await fetch('/api/admin/broadcast-flex', {
        method:'POST', headers: auth(),
        body: JSON.stringify({ altText:'テキスト', contents:{ type:'bubble', body:{ type:'box', layout:'vertical', contents:[{ type:'text', text: msg, wrap:true }] } } })
      });
      const j = await r.json();
      $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
    }
  };

  // ===== 直近アクティブユーザー（一覧＆datalist候補） =====
  async function loadActiveUsers(){
    try{
      const r = await fetch('/api/admin/active-chatters?list=true', { headers: auth() });
      const j = await r.json();
      // サーバー実装が users: [ "Uxxxx", ... ] を返す前提
      const users = Array.isArray(j.users) ? j.users : [];
      show($('#usersOut'), users);
      // datalist を更新
      const dl = $('#userIdList');
      if (dl){
        dl.innerHTML = '';
        users.forEach(u=>{
          const opt = document.createElement('option');
          opt.value = u;
          dl.appendChild(opt);
        });
      }
      return users;
    }catch(e){
      show($('#usersOut'), '取得失敗：'+e.message);
      return [];
    }
  }
  $('#btnActiveUsers').onclick = loadActiveUsers;
  $('#btnLoadActive').onclick  = loadActiveUsers;

  // ===== メッセージログ（tail） =====
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

  // ===== userId 自動入力（URL / localStorage / LIFF / whoami） =====
  const PARAM_NAMES = ["userId", "uid", "me"];
  const LS_KEY = "admin_user_ids";
  const setIfExists = (sel, value) => { const el = $(sel); if (el && value) el.value = value; };
  const saveLocal = (value) => { try { localStorage.setItem(LS_KEY, value); } catch(_){} };
  const loadLocal = () => { try { return localStorage.getItem(LS_KEY) || ""; } catch(_) { return ""; } };
  const applyUserIds = (ids) => {
    setIfExists("#userIds", ids);
    setIfExists("#textUserIds", ids);
    saveLocal(ids);
    const sendFlexRes = $('#sendFlexRes'); if (sendFlexRes && ids) sendFlexRes.textContent = `userId 自動入力: ${ids}`;
    const sendTextRes = $('#sendTextRes'); if (sendTextRes && ids) sendTextRes.textContent = `userId 自動入力: ${ids}`;
  };
  const getFromUrl = () => {
    const u = new URL(location.href);
    for (const key of PARAM_NAMES) {
      if (u.searchParams.has(key)) {
        const v = u.searchParams.get(key);
        if (key === "me" && (v === "1" || v === "true")) return "me";
        if (v) return v.trim();
      }
    }
    const hash = (u.hash || "").replace(/^#/, "");
    const parts = new URLSearchParams(hash);
    for (const key of PARAM_NAMES) {
      if (parts.has(key)) {
        const v = parts.get(key);
        if (key === "me" && (v === "1" || v === "true")) return "me";
        if (v) return v.trim();
      }
    }
    return "";
  };
  const tryLiff = async () => {
    const liffId = document.body?.dataset?.liffId;
    if (!liffId) return "";
    try {
      if (typeof window.liff === "undefined") {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://static.line-scdn.net/liff/edge/2/sdk.js";
          s.onload = resolve; s.onerror = reject;
          document.head.appendChild(s);
        });
      }
      await liff.init({ liffId });
      if (!liff.isLoggedIn()) { liff.login({}); return ""; }
      try { const prof = await liff.getProfile(); if (prof?.userId) return prof.userId; } catch(_){}
      try { const token = liff.getDecodedIDToken(); if (token?.sub) return token.sub; } catch(_){}
    } catch(e) { console.warn("LIFF 取得失敗:", e); }
    return "";
  };
  const tryWhoAmI = async () => {
    try {
      const res = await fetch("/api/admin/whoami", { credentials: "include" });
      if (!res.ok) return "";
      const j = await res.json();
      if (j && j.userId) return j.userId;
    } catch(_) {}
    return "";
  };

  document.addEventListener("DOMContentLoaded", async ()=>{
    // URL 優先
    let candidate = getFromUrl();
    if (candidate) { applyUserIds(candidate === "me" ? "me" : candidate); }
    else {
      candidate = loadLocal();
      if (candidate) applyUserIds(candidate);
      const fromLiff = await tryLiff(); if (fromLiff) { applyUserIds(fromLiff); }
      else {
        const fromApi = await tryWhoAmI(); if (fromApi) applyUserIds(fromApi);
      }
    }
  });

  // 入力修正→保存
  const hookInput = (sel) => {
    const el = $(sel); if (!el) return;
    el.addEventListener("input", () => saveLocal(el.value.trim()));
  };
  hookInput("#userIds");
  hookInput("#textUserIds");

  // 「自分（me）」ボタン
  $('#btnFillMe').onclick = ()=> applyUserIds('me');

})();
