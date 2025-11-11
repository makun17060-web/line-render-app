(function(){
  // ========= 基本ユーティリティ =========
  const $ = (sel)=>document.querySelector(sel);
  const show = (el, data)=>{ el.hidden=false; el.textContent = typeof data==='string' ? data : JSON.stringify(data,null,2); };
  const auth = ()=>({ 'Authorization':'Bearer ' + (($('#token')?.value)||'').trim(), 'Content-Type':'application/json' });

  // fetch → JSON安全化（HTMLが返ってきても落ちない）
  async function safeJson(res){
    const txt = await res.text();
    try{ return JSON.parse(txt); }catch(_){ return { ok:false, httpStatus:res.status, body:txt.slice(0,500) }; }
  }

  // ========= 認証・状態 =========
  $('#btnPing').onclick = async ()=>{
    try{
      const r = await fetch('/api/admin/ping', { headers: auth() });
      const j = await safeJson(r);
      alert(j.ok ? 'OK' : ('NG: '+(j.error||j.httpStatus||'')));
    }catch(e){ alert('ERR '+e); }
  };
  $('#btnHealth').onclick = async ()=>{
    try{
      const r = await fetch('/api/health');
      show($('#healthOut'), await safeJson(r));
    }catch(e){ show($('#healthOut'), String(e)); }
  };

  // ========= 商品取得 / 画像マップ / Flex生成 =========
  let products = [];
  const imageMap = new Map(); // productId => imageURL（管理画面指定 or アップロード結果 or products.jsonのimage）

  // テキストエリア → imageMap 反映
  function parseImageMapTextarea(){
    imageMap.clear();
    const lines = ($('#imageMap')?.value||'').split(/\r?\n/);
    for(const line of lines){
      const t = line.trim();
      if(!t) continue;
      const m = t.split(/\s+/);
      if(m.length >= 2){
        const pid = m[0]; const url = m[1];
        imageMap.set(pid, url);
      }
    }
  }

  // ドロップエリア：画像アップロード（/api/admin/upload があれば使う）
  const dz = $('#dropZone');
  if (dz){
    const stop = e=>{ e.preventDefault(); e.stopPropagation(); };
    ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e=>{ stop(e); dz.classList.add('drag'); }));
    ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e=>{ stop(e); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', async (e)=>{
      const f = e.dataTransfer?.files?.[0];
      if(!f){ return; }
      const pid = prompt('この画像を関連付ける productId を入力してください（例：kusuke-250）');
      if(!pid) return;

      // アップロード試行
      try{
        const fd = new FormData();
        fd.append('file', f, f.name || 'image');
        fd.append('productId', pid);
        const r = await fetch('/api/admin/upload', { method:'POST', headers: { 'Authorization': auth()['Authorization'] }, body: fd });
        if (r.ok){
          const j = await safeJson(r);
          // サーバーが {ok:true, url:"https://..."} を返す前提
          if (j.ok && j.url){
            imageMap.set(pid, j.url);
            // テキストエリアへも反映
            const cur = ($('#imageMap').value||'').trim();
            $('#imageMap').value = (cur ? cur + '\n' : '') + `${pid} ${j.url}`;
            $('#uploadNote').hidden = false;
            $('#uploadNote').textContent = `アップロード成功: ${pid} → ${j.url}`;
            return;
          }
        }
        // 失敗時はプレビュー用の ObjectURL を作り、URL入力を促す
        const blobUrl = URL.createObjectURL(f);
        imageMap.set(pid, blobUrl);
        $('#uploadNote').hidden = false;
        $('#uploadNote').textContent = `アップロード未対応/失敗。プレビューのみ（LINEで配信するには公開URLが必要です）。${pid} → (blob)`;
      }catch(err){
        const blobUrl = URL.createObjectURL(f);
        imageMap.set(pid, blobUrl);
        $('#uploadNote').hidden = false;
        $('#uploadNote').textContent = `アップロードエラー。プレビューのみ：${String(err)}`;
      }
    });
  }

  $('#btnLoadProducts').onclick = async ()=>{
    try{
      const r = await fetch('/api/admin/products', { headers: auth() });
      const j = await safeJson(r);
      if (!j.ok) return alert('取得失敗: '+(j.error||j.httpStatus||''));
      products = (j.items||[]).map(p => ({ ...p }));
      // products.json 側 image を imageMapへ
      for(const p of products){
        if (p.image) imageMap.set(p.id, p.image);
      }
      $('#prodCount').textContent = `取得 ${products.length} 件`;
    }catch(e){ alert('ERR '+e); }
  };

  function yen(n){ return Number(n||0).toLocaleString('ja-JP')+'円'; }

  function buildFlex(){
    parseImageMapTextarea(); // 最新を反映
    const hideRaw = ($('#hideIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    const visible = products.filter(p=>!hideRaw.includes(p.id));

    const bubbles = visible.map(p=>{
      const heroUrl = imageMap.get(p.id) || p.image || "";
      const body = {
        type:'box', layout:'vertical', spacing:'sm', contents:[
          { type:'text', text:p.name, weight:'bold', size:'md', wrap:true },
          { type:'text', text:`価格：${yen(p.price)}　在庫：${p.stock??0}`, size:'sm', wrap:true },
          p.desc ? { type:'text', text:p.desc, size:'sm', wrap:true } : { type:'box', layout:'vertical', contents:[] }
        ]
      };
      const bubble = { type:'bubble', body,
        footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
          { type:'button', style:'primary', action:{ type:'postback', label:'数量を選ぶ', data:`order_qty?id=${encodeURIComponent(p.id)}&qty=1` } }
        ]}
      };
      if (heroUrl){
        bubble.hero = { type:'image', url: heroUrl, size:'full', aspectMode:'cover', aspectRatio:'20:13' };
      }
      return bubble;
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
      altText: ($('#altText').value||'商品一覧').slice(0,400),
      contents: bubbles.length===1 ? bubbles[0] : { type:'carousel', contents:bubbles }
    };
  }

  $('#btnBuildFlex').onclick = ()=>{
    if (!products.length) return alert('先に商品を取得してください');
    const payload = buildFlex();
    show($('#flexPreview'), payload);
  };

  // ========= 配信（Flex / テキスト） =========
  $('#btnSendFlex').onclick = async ()=>{
    if (!products.length) return alert('先に商品を取得してください');
    const payload = buildFlex();
    const raw = ($('#userIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    const ids = raw.filter(Boolean);
    const url = ids.length ? '/api/admin/segment/send-flex' : '/api/admin/broadcast-flex';
    const body = ids.length ? { userIds: ids, altText: payload.altText, contents: payload.contents }
                            : { altText: payload.altText, contents: payload.contents };
    const r = await fetch(url, { method:'POST', headers: auth(), body: JSON.stringify(body) });
    const j = await safeJson(r);
    $('#sendFlexRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||j.httpStatus||'')) ;
  };

  $('#btnSendText').onclick = async ()=>{
    const msg = ($('#textMessage').value||'').trim();
    if (!msg) return alert('本文が空です');
    const ids = ($('#textUserIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (ids.length){
      const r = await fetch('/api/admin/segment/send', { method:'POST', headers: auth(), body: JSON.stringify({ userIds: ids, message: msg }) });
      const j = await safeJson(r);
      $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||j.httpStatus||'')) ;
    } else {
      // ブロードキャストは Flex 包装
      const r = await fetch('/api/admin/broadcast-flex', {
        method:'POST', headers: auth(),
        body: JSON.stringify({ altText:'テキスト', contents:{ type:'bubble', body:{ type:'box', layout:'vertical', contents:[{ type:'text', text: msg, wrap:true }] } } })
      });
      const j = await safeJson(r);
      $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||j.httpStatus||'')) ;
    }
  };

  // ========= アクティブユーザー → datalist =========
  $('#btnLoadActive').onclick = async ()=>{
    try{
      const r = await fetch('/api/admin/active-chatters?list=true', { headers: auth() });
      const j = await safeJson(r);
      const dl = $('#uidList');
      dl.innerHTML = '';
      if (j.ok && Array.isArray(j.users)){
        for (const u of j.users){
          const opt = document.createElement('option'); opt.value = u; dl.appendChild(opt);
        }
        $('#activeInfo').textContent = `ユニーク: ${j.uniqueUsers||j.users.length} / メッセージ: ${j.totalMessages||'-'}`;
      } else {
        $('#activeInfo').textContent = '取得失敗（トークン/権限を確認）';
      }
    }catch(e){
      $('#activeInfo').textContent = '取得エラー: ' + String(e);
    }
  };

  // ========= メッセージログ =========
  async function loadLog(){
    const r = await fetch('/api/admin/messages?limit=200', { headers: auth() });
    const j = await safeJson(r);
    show($('#logOut'), j);
  }
  $('#btnLoadLog').onclick = loadLog;

  let auto=false, timer=null;
  $('#btnAutoRefresh').onclick = ()=>{
    auto = !auto; $('#autoStatus').textContent = auto ? 'ON' : 'OFF';
    if (auto){ loadLog(); timer = setInterval(loadLog, 10000); } else { clearInterval(timer); }
  };

  // ========= userId 自動入力（URL / localStorage / LIFF / whoami） =========
  const USER_IDS_INPUT_SELECTOR = "#userIds";
  const TEXT_USER_IDS_INPUT_SELECTOR = "#textUserIds";
  const PARAM_NAMES = ["userId", "uid", "me"];
  const LS_KEY = "admin_user_ids";

  const setIfExists = (sel, value) => { const el = $(sel); if (el && value) el.value = value; };
  const saveLocal = (value) => { try { localStorage.setItem(LS_KEY, value); } catch(_){} };
  const loadLocal = () => { try { return localStorage.getItem(LS_KEY) || ""; } catch(_){ return ""; } };

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

  const applyUserIds = (ids) => {
    setIfExists(USER_IDS_INPUT_SELECTOR, ids);
    setIfExists(TEXT_USER_IDS_INPUT_SELECTOR, ids);
    saveLocal(ids);
    const sendFlexRes = document.getElementById("sendFlexRes");
    if (sendFlexRes && ids) sendFlexRes.textContent = `userId 自動入力: ${ids}`;
    const sendTextRes = document.getElementById("sendTextRes");
    if (sendTextRes && ids) sendTextRes.textContent = `userId 自動入力: ${ids}`;
  };

  const tryLiff = async () => {
    const liffId = document.body?.dataset?.liffId;
    if (!liffId) return "";
    try{
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
      try { const tok = liff.getDecodedIDToken(); if (tok?.sub) return tok.sub; } catch(_){}
    }catch(e){ console.warn("LIFF 取得失敗:", e); }
    return "";
  };

  const tryWhoAmI = async () => {
    try {
      const r = await fetch("/api/admin/whoami", { credentials: "include" });
      if (!r.ok) return "";
      const j = await safeJson(r);
      if (j && j.userId) return j.userId;
    } catch(_){}
    return "";
  };

  document.addEventListener("DOMContentLoaded", async () => {
    // 1) URL最優先
    let candidate = getFromUrl();
    if (candidate) { applyUserIds(candidate === "me" ? "me" : candidate); }
    else {
      // 2) ローカル
      candidate = loadLocal();
      if (candidate) applyUserIds(candidate);
    }
    // 3) LIFF / whoami で上書き可能
    const fromLiff = await tryLiff(); if (fromLiff) applyUserIds(fromLiff);
    const fromApi  = await tryWhoAmI(); if (fromApi) applyUserIds(fromApi);
  });

  const hookInput = (sel) => {
    const el = $(sel); if (!el) return;
    el.addEventListener("input", () => saveLocal(el.value.trim()));
  };
  hookInput(USER_IDS_INPUT_SELECTOR);
  hookInput(TEXT_USER_IDS_INPUT_SELECTOR);
})();
