(function(){
  const $  = (sel)=>document.querySelector(sel);
  const $$ = (sel)=>Array.from(document.querySelectorAll(sel));
  const show = (el, data)=>{ el.hidden=false; el.textContent = typeof data==='string' ? data : JSON.stringify(data,null,2); };
  const auth = ()=>({ 'Authorization':'Bearer ' + ($('#token').value||'').trim(), 'Content-Type':'application/json' });

  // =========================
  //  共通：通貨・URLパラメータ
  // =========================
  function yen(n){ return Number(n||0).toLocaleString('ja-JP')+'円'; }
  const url = new URL(location.href);
  const getQP = (k)=>url.searchParams.get(k);

  // =========================
  //  認証・状態
  // =========================
  if ($('#btnPing')) {
    $('#btnPing').onclick = async ()=>{
      try{
        const r = await fetch('/api/admin/ping', { headers: auth() });
        const j = await r.json();
        alert(j.ok ? 'OK' : ('NG: '+(j.error||'')));
      }catch(e){ alert('ERR '+e); }
    };
  }
  if ($('#btnHealth')) {
    $('#btnHealth').onclick = async ()=>{
      try{
        const r = await fetch('/api/health');
        show($('#healthOut'), await r.json());
      }catch(e){ show($('#healthOut'), String(e)); }
    };
  }

  // =========================
  //  商品取得 → Flex生成
  // =========================
  let products = [];
  if ($('#btnLoadProducts')) {
    $('#btnLoadProducts').onclick = async ()=>{
      const r = await fetch('/api/admin/products', { headers: auth() });
      const j = await r.json();
      if (!j.ok) return alert('取得失敗: '+(j.error||''));
      products = j.items||[];
      $('#prodCount').textContent = `取得 ${products.length} 件`;
    };
  }

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
        { type:'button', style:'primary', action:{ type:'postback', label:'数量を選ぶ', data:`order_qty?id=${encodeURIComponent(p.id)}&qty=1` } }
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

  if ($('#btnBuildFlex')) {
    $('#btnBuildFlex').onclick = ()=>{
      if (!products.length) return alert('先に商品を取得してください');
      show($('#flexPreview'), buildFlex());
    };
  }

  // =========================
  //  配信（Flex）
  // =========================
  if ($('#btnSendFlex')) {
    $('#btnSendFlex').onclick = async ()=>{
      if (!products.length) return alert('先に商品を取得してください');
      const payload = buildFlex();
      const ids = readIdsFromInputs(); // ← 下に定義
      const url = ids.length ? '/api/admin/segment/send-flex' : '/api/admin/broadcast-flex';
      const body = ids.length ? { userIds: ids, altText: payload.altText, contents: payload.contents }
                              : { altText: payload.altText, contents: payload.contents };
      const r = await fetch(url, { method:'POST', headers: auth(), body: JSON.stringify(body) });
      const j = await r.json();
      $('#sendFlexRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
    };
  }

  // =========================
  //  テキスト配信
  // =========================
  if ($('#btnSendText')) {
    $('#btnSendText').onclick = async ()=>{
      const msg = ($('#textMessage').value||'').trim();
      if (!msg) return alert('本文が空です');
      const ids = readIdsFromInputs(true);
      if (ids.length){
        const r = await fetch('/api/admin/segment/send', { method:'POST', headers: auth(), body: JSON.stringify({ userIds: ids, message: msg }) });
        const j = await r.json();
        $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
      } else {
        // ブロードキャストは Flex 経由でテキストを包む（既存API流用）
        const r = await fetch('/api/admin/broadcast-flex', {
          method:'POST', headers: auth(),
          body: JSON.stringify({ altText:'テキスト', contents:{ type:'bubble', body:{ type:'box', layout:'vertical', contents:[{ type:'text', text: msg, wrap:true }] } } })
        });
        const j = await r.json();
        $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
      }
    };
  }

  // =========================
  //  メッセージログ
  // =========================
  async function loadLog(){
    const r = await fetch('/api/admin/messages?limit=200', { headers: auth() });
    const j = await r.json();
    show($('#logOut'), j);
  }
  if ($('#btnLoadLog')) $('#btnLoadLog').onclick = loadLog;

  let auto=false, timer=null;
  if ($('#btnAutoRefresh')) {
    $('#btnAutoRefresh').onclick = ()=>{
      auto = !auto; $('#autoStatus').textContent = auto ? 'ON' : 'OFF';
      if (auto){ loadLog(); timer = setInterval(loadLog, 10000); } else { clearInterval(timer); }
    };
  }

  // =========================================================
  //  ▼▼ ここから「ほかの userId 自動入力（選択式）」機能 ▼▼
  // =========================================================

  // 保持と入出力
  const LS_KEY_MULTI = "admin_user_ids_multi";
  const USER_IDS_INPUT_SELECTOR = "#userIds";
  const TEXT_USER_IDS_INPUT_SELECTOR = "#textUserIds";
  const selected = new Set();

  const setIfExists = (sel, value) => { const el = $(sel); if (el) el.value = value; };
  const saveLocal = () => { try { localStorage.setItem(LS_KEY_MULTI, Array.from(selected).join(",")); } catch(_){} };
  const loadLocal = () => { try { return (localStorage.getItem(LS_KEY_MULTI)||"").split(",").map(s=>s.trim()).filter(Boolean); } catch(_) { return []; } };

  // 入力欄と選択セットを同期
  function refreshInputsFromSelected(){
    const csv = Array.from(selected).join(",");
    setIfExists(USER_IDS_INPUT_SELECTOR, csv);
    setIfExists(TEXT_USER_IDS_INPUT_SELECTOR, csv);
    saveLocal();
    if ($('#sendFlexRes')) $('#sendFlexRes').textContent = csv ? `userIds: ${csv}` : '';
    if ($('#sendTextRes')) $('#sendTextRes').textContent = csv ? `userIds: ${csv}` : '';
  }

  // 入力欄 → セット（手打ち更新も拾う）
  function syncSelectedFromInputs(){
    selected.clear();
    readIdsFromInputs().forEach(id=>selected.add(id));
    paintUserPills(); // ビジュアルを更新
    saveLocal();
  }

  // 汎用読み取り
  function readIdsFromInputs(useTextBox=false){
    const raw = (useTextBox? $('#textUserIds') : $('#userIds'))?.value || "";
    return raw.split(",").map(s=>s.trim()).filter(Boolean);
  }

  // ユーザーピル用コンテナを用意（<pre id="usersOut"> の直下に作成）
  let pillsHost = null;
  function ensurePillsHost(){
    if (!pillsHost){
      const pre = $('#usersOut');
      pillsHost = document.createElement('div');
      pillsHost.id = "usersList";
      pillsHost.style.margin = "8px 0";
      pillsHost.style.display = "flex";
      pillsHost.style.flexWrap = "wrap";
      pillsHost.style.gap = "6px";
      pre?.insertAdjacentElement('beforebegin', pillsHost);

      // 操作用ボタン群
      const bar = document.createElement('div');
      bar.style.display = "flex";
      bar.style.gap = "8px";
      bar.style.marginBottom = "6px";

      const btnAll = mkBtn("全選択", ()=>{ lastUsers.forEach(u=>selected.add(u)); refreshInputsFromSelected(); paintUserPills(); });
      const btnNone = mkBtn("全解除", ()=>{ selected.clear(); refreshInputsFromSelected(); paintUserPills(); });
      const btnClear = mkBtn("クリア（入力欄）", ()=>{ selected.clear(); refreshInputsFromSelected(); paintUserPills(); });
      bar.append(btnAll, btnNone, btnClear);
      pillsHost.insertAdjacentElement('beforebegin', bar);
    }
  }

  function mkBtn(label, onClick){
    const b = document.createElement('button');
    b.textContent = label;
    b.className = 'secondary';
    b.style.cursor = "pointer";
    b.onclick = onClick;
    return b;
  }

  // ピル描画
  function pill(id){
    const span = document.createElement('span');
    span.textContent = id;
    span.className = 'pill';
    span.style.userSelect = "text";
    span.style.cursor = "pointer";
    const active = selected.has(id);
    span.style.background = active ? "#6aa3ff" : "#20305c";
    span.style.color = active ? "#06102b" : "#cfe0ff";
    span.style.borderColor = active ? "#6aa3ff" : "#35477b";
    span.onclick = ()=>{
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      refreshInputsFromSelected();
      paintUserPills();
    };
    return span;
  }

  let lastUsers = [];
  function paintUserPills(){
    if (!pillsHost) return;
    pillsHost.innerHTML = "";
    lastUsers.forEach(u => pillsHost.appendChild(pill(u)));
  }

  // 「直近アクティブユーザー取得」 → 一覧 + クリック選択
  if ($('#btnActiveUsers')) {
    $('#btnActiveUsers').onclick = async ()=>{
      const r = await fetch('/api/admin/active-chatters?list=true', { headers: auth() });
      const j = await r.json();
      show($('#usersOut'), j);
      // 返却形：{ ok, users: ["Uxxx", ...] } を優先、なければ keys 探索
      const list = Array.isArray(j?.users) ? j.users
                 : Array.isArray(j)          ? j
                 : Array.isArray(j?.items)   ? j.items
                 : [];
      lastUsers = list.filter(Boolean);
      ensurePillsHost();
      paintUserPills();
    };
  }

  // 入力欄手修正 → 追随保存
  const hookInput = (sel) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener("input", () => syncSelectedFromInputs());
  };
  hookInput(USER_IDS_INPUT_SELECTOR);
  hookInput(TEXT_USER_IDS_INPUT_SELECTOR);

  // =========================
  //  初期化：URL/保存/LIFF/whoami
  // =========================
  async function tryLiff(){
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
      if (!liff.isLoggedIn()){ liff.login({}); return ""; }
      try { const p = await liff.getProfile(); if (p?.userId) return p.userId; } catch(_){}
      try { const t = liff.getDecodedIDToken(); if (t?.sub) return t.sub; } catch(_){}
    }catch(e){ console.warn("LIFF 取得失敗:", e); }
    return "";
  }

  async function tryWhoAmI(){
    try{
      const res = await fetch("/api/admin/whoami", { credentials: "include" });
      if (!res.ok) return "";
      const j = await res.json();
      if (j?.userId) return j.userId;
    }catch(_){}
    return "";
  }

  function pushIfValid(id){ if (id && !selected.has(id)) selected.add(id); }

  document.addEventListener("DOMContentLoaded", async ()=>{
    ensurePillsHost();

    // 1) URL ?userIds=U1,U2 / ?userId=U / ?uid=U / ?me=1
    const urlCsv = getQP('userIds');
    const urlOne = getQP('userId') || getQP('uid');
    const urlMe  = getQP('me');

    if (urlCsv){
      urlCsv.split(',').map(s=>s.trim()).filter(Boolean).forEach(pushIfValid);
    } else if (urlOne){
      pushIfValid(urlOne.trim());
    } else if (urlMe && (urlMe === '1' || urlMe === 'true')){
      pushIfValid('me'); // サーバで "me" を解決する運用
    }

    // 2) ローカル復元
    if (selected.size === 0){
      loadLocal().forEach(pushIfValid);
    }

    // 3) 自分の userId（LIFF / whoami）を補完（未選択なら）
    if (selected.size === 0){
      const meFromLiff = await tryLiff();
      if (meFromLiff) pushIfValid(meFromLiff);
    }
    if (selected.size === 0){
      const meFromApi = await tryWhoAmI();
      if (meFromApi) pushIfValid(meFromApi);
    }

    // 4) 反映
    refreshInputsFromSelected();
    paintUserPills();
  });

})();
// === 他ユーザーの userId を自動候補化＆自動入力 =========================
(function(){
  const $ = (sel)=>document.querySelector(sel);
  const LS_KEY = "admin_user_ids";

  // datalist を動的に用意して #userIds / #textUserIds に関連付け
  function ensureDatalist(){
    let dl = document.getElementById("uids");
    if(!dl){
      dl = document.createElement("datalist");
      dl.id = "uids";
      document.body.appendChild(dl);
    }
    const in1 = document.getElementById("userIds");
    const in2 = document.getElementById("textUserIds");
    if(in1) in1.setAttribute("list","uids");
    if(in2) in2.setAttribute("list","uids");
    return dl;
  }

  // /api/admin/active-chatters?list=true から候補取得
  async function fetchActiveUserIds(){
    const tokenEl = document.getElementById("token");
    const token = (tokenEl?.value||"").trim();
    if(!token) return [];
    const r = await fetch("/api/admin/active-chatters?list=true", {
      headers: { "Authorization":"Bearer "+token }
    });
    const j = await r.json();
    return (j && j.ok && Array.isArray(j.users)) ? j.users : [];
  }

  // 候補を datalist に反映
  function fillDatalist(ids){
    const dl = ensureDatalist();
    dl.innerHTML = "";
    ids.forEach(id=>{
      const opt = document.createElement("option");
      opt.value = id;
      dl.appendChild(opt);
    });
  }

  // まだ未入力なら、先頭のIDを自動入力（複数ほしいなら上位N件をカンマ連結）
  function autofillIfEmpty(ids, topN = 1){
    const in1 = document.getElementById("userIds");
    const in2 = document.getElementById("textUserIds");
    const joined = ids.slice(0, topN).join(", ");
    if(in1 && !in1.value && joined){ in1.value = joined; }
    if(in2 && !in2.value && joined){ in2.value = joined; }
    if(joined){ try{ localStorage.setItem(LS_KEY, joined); }catch{} }
  }

  // token が入力されたら自動取得して候補化
  function hookTokenWatcher(){
    const tokenEl = document.getElementById("token");
    if(!tokenEl) return;
    let timer = null;
    const kick = async ()=>{
      try{
        const ids = await fetchActiveUserIds();
        fillDatalist(ids);
        // すでに自分のIDが自動で入っている環境では、他のIDがあれば1件だけ差し替えたい場合はここで制御
        // 例: 2件自動入力したい→ autofillIfEmpty(ids, 2)
        autofillIfEmpty(ids, 1);
        const usersOut = document.getElementById("usersOut");
        if(usersOut){ usersOut.hidden = false; usersOut.textContent = JSON.stringify(ids, null, 2); }
      }catch(e){ /* 無視（権限/通信エラーなど） */ }
    };
    const schedule = ()=>{ clearTimeout(timer); timer = setTimeout(kick, 400); };
    ["change","blur","keyup","input"].forEach(ev => tokenEl.addEventListener(ev, schedule));
  }

  // 既存の「直近アクティブユーザー取得」ボタンにフックして、自動で入力欄へ反映
  function hookActiveUsersButton(){
    const btn = document.getElementById("btnActiveUsers");
    if(!btn) return;
    const orig = btn.onclick;
    btn.onclick = async (ev)=>{
      if(typeof orig === "function"){ try{ await orig(ev); }catch{} }
      try{
        const ids = await fetchActiveUserIds();
        fillDatalist(ids);
        // ここでは上位3人を入れてみる例（必要に応じて 1 に変更）
        autofillIfEmpty(ids, 3);
      }catch(_){}
    };
  }

  // URL パラメータ ?userIds=Uxxx,Uyyy を優先して自動反映（任意）
  function applyFromUrl(){
    const u = new URL(location.href);
    const p = u.searchParams.get("userIds") || u.searchParams.get("uids");
    if(!p) return false;
    const val = p.split(",").map(s=>s.trim()).filter(Boolean).join(", ");
    const in1 = document.getElementById("userIds");
    const in2 = document.getElementById("textUserIds");
    if(in1) in1.value = val;
    if(in2) in2.value = val;
    try{ localStorage.setItem(LS_KEY, val); }catch{}
    return true;
  }

  document.addEventListener("DOMContentLoaded", ()=>{
    ensureDatalist();
    applyFromUrl();         // URL で指定があればそれを優先
    hookTokenWatcher();     // token 入力後に自動取得
    hookActiveUsersButton();// 既存ボタン経由のときも自動で入力
  });
})();
