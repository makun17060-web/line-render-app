// =========================
// admin.js (full)
// =========================

// 既存：管理UI本体
(function(){
  const $ = (sel)=>document.querySelector(sel);
  const show = (el, data)=>{ el.hidden=false; el.textContent = typeof data==='string' ? data : JSON.stringify(data,null,2); };
  const auth = ()=>({ 'Authorization':'Bearer ' + (($('#token')?.value)||'').trim(), 'Content-Type':'application/json' });

  // 認証・状態
  const btnPing = $('#btnPing');
  if (btnPing) {
    btnPing.onclick = async ()=>{
      try{
        const r = await fetch('/api/admin/ping', { headers: auth() });
        const j = await r.json();
        alert(j.ok ? 'OK' : ('NG: '+(j.error||'')));
      }catch(e){ alert('ERR '+e); }
    };
  }
  const btnHealth = $('#btnHealth');
  if (btnHealth) {
    btnHealth.onclick = async ()=>{
      try{
        const r = await fetch('/api/health');
        show($('#healthOut'), await r.json());
      }catch(e){ show($('#healthOut'), String(e)); }
    };
  }

  // 商品取得 → Flex生成
  let products = [];
  const btnLoadProducts = $('#btnLoadProducts');
  if (btnLoadProducts) {
    btnLoadProducts.onclick = async ()=>{
      const r = await fetch('/api/admin/products', { headers: auth() });
      const j = await r.json();
      if (!j.ok) return alert('取得失敗: '+(j.error||''));
      products = j.items||[];
      const pc = $('#prodCount'); if (pc) pc.textContent = `取得 ${products.length} 件`;
    };
  }

  function yen(n){ return Number(n||0).toLocaleString('ja-JP')+'円'; }
  function buildFlex(){
    const hideRaw = (($('#hideIds')?.value)||'').split(',').map(s=>s.trim()).filter(Boolean);
    const visible = products.filter(p=>!hideRaw.includes(p.id));
    const bubbles = visible.map(p=>({
      type:'bubble',
      body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
        { type:'text', text:p.name, weight:'bold', size:'md', wrap:true },
        { type:'text', text:`価格：${yen(p.price)}　在庫：${p.stock??0}`, size:'sm', wrap:true },
        p.desc ? { type:'text', text:p.desc, size:'sm', wrap:true } : { type:'box', layout:'vertical', contents:[] }
      ]},
      footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
        { type:'button', style:'primary', action:{ type:'postback', label:'数量を選ぶ', data:`order_qty?id=${encodeURIComponent(p.id)}&qty=1` } }
      ] }
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
      altText: ((($('#altText')?.value)||'商品一覧')).slice(0,400),
      contents: bubbles.length===1 ? bubbles[0] : { type:'carousel', contents:bubbles }
    };
  }

  const btnBuildFlex = $('#btnBuildFlex');
  if (btnBuildFlex) {
    btnBuildFlex.onclick = ()=>{
      if (!products.length) return alert('先に商品を取得してください');
      show($('#flexPreview'), buildFlex());
    };
  }

  // 配信（Flex）
  const btnSendFlex = $('#btnSendFlex');
  if (btnSendFlex) {
    btnSendFlex.onclick = async ()=>{
      if (!products.length) return alert('先に商品を取得してください');
      const payload = buildFlex();
      const ids = ((($('#userIds')?.value)||'').split(',').map(s=>s.trim()).filter(Boolean));
      const url = ids.length ? '/api/admin/segment/send-flex' : '/api/admin/broadcast-flex';
      const body = ids.length ? { userIds: ids, altText: payload.altText, contents: payload.contents }
                              : { altText: payload.altText, contents: payload.contents };
      const r = await fetch(url, { method:'POST', headers: auth(), body: JSON.stringify(body) });
      const j = await r.json();
      const res = $('#sendFlexRes'); if (res) res.textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
    };
  }

  // テキスト配信
  const btnSendText = $('#btnSendText');
  if (btnSendText) {
    btnSendText.onclick = async ()=>{
      const msg = ((($('#textMessage')?.value)||'').trim());
      if (!msg) return alert('本文が空です');
      const ids = ((($('#textUserIds')?.value)||'').split(',').map(s=>s.trim()).filter(Boolean));
      if (ids.length){
        const r = await fetch('/api/admin/segment/send', { method:'POST', headers: auth(), body: JSON.stringify({ userIds: ids, message: msg }) });
        const j = await r.json();
        const res = $('#sendTextRes'); if (res) res.textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
      } else {
        // ブロードキャストは Flex 経由でテキストを包む（既存API流用）
        const r = await fetch('/api/admin/broadcast-flex', {
          method:'POST', headers: auth(),
          body: JSON.stringify({ altText:'テキスト', contents:{ type:'bubble', body:{ type:'box', layout:'vertical', contents:[{ type:'text', text: msg, wrap:true }] } } })
        });
        const j = await r.json();
        const res = $('#sendTextRes'); if (res) res.textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
      }
    };
  }

  // ユーザー収集
  const btnActiveUsers = $('#btnActiveUsers');
  if (btnActiveUsers) {
    btnActiveUsers.onclick = async ()=>{
      const r = await fetch('/api/admin/active-chatters?list=true', { headers: auth() });
      const j = await r.json();
      show($('#usersOut'), j);
    };
  }

  // メッセージログ（tail相当）
  async function loadLog(){
    const r = await fetch('/api/admin/messages?limit=200', { headers: auth() });
    const j = await r.json();
    show($('#logOut'), j);
  }
  const btnLoadLog = $('#btnLoadLog');
  if (btnLoadLog) btnLoadLog.onclick = loadLog;

  let auto=false, timer=null;
  const btnAuto = $('#btnAutoRefresh');
  if (btnAuto) {
    btnAuto.onclick = ()=>{
      auto = !auto; const badge = $('#autoStatus'); if (badge) badge.textContent = auto ? 'ON' : 'OFF';
      if (auto){ loadLog(); timer = setInterval(loadLog, 10000); } else { clearInterval(timer); }
    };
  }

  console.log('[admin] UI handlers ready');
})();


// 追加：userId 自動入力スニペット（<script>タグなしでOK）
(function(){
  // ------- 設定 -------
  const USER_IDS_INPUT_SELECTOR = "#userIds";
  const TEXT_USER_IDS_INPUT_SELECTOR = "#textUserIds";
  const PARAM_NAMES = ["userId", "uid", "me"];
  const LS_KEY = "admin_user_ids";

  // ------- ユーティリティ -------
  const $ = (sel) => document.querySelector(sel);
  const setIfExists = (sel, value) => { const el = $(sel); if (el && value) el.value = value; };
  const saveLocal = (value) => { try { localStorage.setItem(LS_KEY, value); } catch(_){} };
  const loadLocal = () => { try { return localStorage.getItem(LS_KEY) || ""; } catch(_) { return ""; } };

  // URL から userId 候補を拾う
  const getFromUrl = () => {
    const u = new URL(location.href);
    for (const key of PARAM_NAMES) {
      if (u.searchParams.has(key)) {
        const v = u.searchParams.get(key);
        if (key === "me" && (v === "1" || v === "true")) return "me";
        if (v) return v.trim();
      }
    }
    // ハッシュ側も対応 #userId= / #uid=
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

  // 画面へ反映
  const applyUserIds = (ids) => {
    setIfExists(USER_IDS_INPUT_SELECTOR, ids);
    setIfExists(TEXT_USER_IDS_INPUT_SELECTOR, ids);
    saveLocal(ids);
    const sendFlexRes = document.getElementById("sendFlexRes");
    if (sendFlexRes && ids) sendFlexRes.textContent = `userId 自動入力: ${ids}`;
    const sendTextRes = document.getElementById("sendTextRes");
    if (sendTextRes && ids) sendTextRes.textContent = `userId 自動入力: ${ids}`;
  };

  // LIFF からの取得（任意）
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
      try {
        const prof = await liff.getProfile();
        if (prof?.userId) return prof.userId;
      } catch(_){}
      try {
        const token = liff.getDecodedIDToken();
        if (token?.sub) return token.sub;
      } catch(_){}
    } catch(e) {
      console.warn("LIFF 取得失敗:", e);
    }
    return "";
  };

  // /api 側から逆引き（任意）
  const tryWhoAmI = async () => {
    try {
      const res = await fetch("/api/admin/whoami", { credentials: "include" });
      if (!res.ok) return "";
      const j = await res.json();
      if (j && j.userId) return j.userId;
    } catch(_){}
    return "";
  };

  // 起動処理
  document.addEventListener("DOMContentLoaded", async () => {
    let candidate = getFromUrl();
    if (candidate) { applyUserIds(candidate === "me" ? "me" : candidate); return; }

    candidate = loadLocal();
    if (candidate) { applyUserIds(candidate); /* 以降で上書きの可能性あり */ }

    const fromLiff = await tryLiff();
    if (fromLiff) { applyUserIds(fromLiff); return; }

    const fromApi = await tryWhoAmI();
    if (fromApi) { applyUserIds(fromApi); return; }

    console.log("[admin] userId auto-fill: no source found");
  });

  // 手入力 → 自動保存
  const hookInput = (sel) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener("input",
