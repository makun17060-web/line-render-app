(function(){
  const $  = (sel)=>document.querySelector(sel);
  const $$ = (sel)=>Array.from(document.querySelectorAll(sel));
  const show = (el, data)=>{ el.hidden=false; el.textContent = typeof data==='string' ? data : JSON.stringify(data,null,2); };
  const auth = ()=>({ 'Authorization':'Bearer ' + (($('#token')?.value)||'').trim(), 'Content-Type':'application/json' });

  // =========================
  // 既存: 認証・状態
  // =========================
  $('#btnPing')?.addEventListener('click', async ()=>{
    try{
      const r = await fetch('/api/admin/ping', { headers: auth() });
      const j = await r.json();
      alert(j.ok ? 'OK' : ('NG: '+(j.error||'')));
    }catch(e){ alert('ERR '+e); }
  });

  $('#btnHealth')?.addEventListener('click', async ()=>{
    try{
      const r = await fetch('/api/health');
      show($('#healthOut'), await r.json());
    }catch(e){ show($('#healthOut'), String(e)); }
  });

  // =========================
  // 既存: 商品取得 → Flex生成
  // =========================
  let products = [];
  $('#btnLoadProducts')?.addEventListener('click', loadProducts);
  async function loadProducts(){
    const r = await fetch('/api/admin/products', { headers: auth() });
    const j = await r.json();
    if (!j.ok) return alert('取得失敗: '+(j.error||''));
    products = j.items||[];
    $('#prodCount').textContent = `取得 ${products.length} 件`;

    // 画像管理側のセレクトを更新
    refreshImageTargetOptions();
    // サムネグリッドも更新
    renderThumbGrid();
  }

  function yen(n){ return Number(n||0).toLocaleString('ja-JP')+'円'; }

  // =========================
  // ★ 追加: 画像マッピング
  // =========================
  // { [productId]: absoluteOrRootedUrl }
  const LS_IMG_KEY = 'admin_product_images';
  const imageMap = loadImageMap();

  function loadImageMap(){
    try { return JSON.parse(localStorage.getItem(LS_IMG_KEY)||'{}') } catch(_){ return {}; }
  }
  function saveImageMap(){
    try { localStorage.setItem(LS_IMG_KEY, JSON.stringify(imageMap)) } catch(_){}
  }

  function getImageUrlFor(id){
    return imageMap[id] || '';
  }

  function refreshImageTargetOptions(){
    const sel = $('#imageTarget');
    if (!sel) return;
    sel.innerHTML = '';
    if (!products.length){
      sel.append(new Option('（先に商品を取得してください）',''));
      return;
    }
    sel.append(new Option('商品を選択…',''));
    for (const p of products){
      sel.append(new Option(`${p.name} (${p.id})`, p.id));
    }
  }

  // D&D UI
  const dropZone = $('#dropZone');
  const filePick = $('#filePick');

  if (dropZone){
    const openPicker = ()=> filePick?.click();
    dropZone.addEventListener('click', openPicker);

    ['dragenter','dragover'].forEach(ev=>{
      dropZone.addEventListener(ev, (e)=>{ e.preventDefault(); e.stopPropagation(); dropZone.style.background='#0f1630'; });
    });
    ;['dragleave','drop'].forEach(ev=>{
      dropZone.addEventListener(ev, (e)=>{ e.preventDefault(); e.stopPropagation(); dropZone.style.background=''; });
    });

    dropZone.addEventListener('drop', (e)=>{
      const files = e.dataTransfer?.files;
      if (files && files.length) handlePickedFile(files[0]);
    });
  }
  filePick?.addEventListener('change', (e)=>{
    const f = e.target.files?.[0];
    if (f) handlePickedFile(f);
    filePick.value = '';
  });

  async function handlePickedFile(file){
    const targetId = $('#imageTarget')?.value || '';
    if (!targetId) return alert('画像を紐づける「商品」を選択してください');

    // アップロード
    try{
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: { 'Authorization': auth()['Authorization'] }, // Content-TypeはFormData任せ
        body: fd
      });
      const j = await r.json();
      if (!j.ok) return alert('アップロード失敗: ' + (j.error||''));

      // 返ってきたURLを絶対URLに（FlexはHTTPS必須）
      const absoluteUrl = j.url.startsWith('http')
        ? j.url
        : new URL(j.url, location.origin).toString();

      imageMap[targetId] = absoluteUrl;
      saveImageMap();
      renderThumbGrid();
      alert('画像を登録しました');
    }catch(e){
      console.error(e);
      alert('アップロードエラー: ' + e);
    }
  }

  $('#btnClearImage')?.addEventListener('click', ()=>{
    const targetId = $('#imageTarget')?.value || '';
    if (!targetId) return alert('商品を選択してください');
    delete imageMap[targetId];
    saveImageMap();
    renderThumbGrid();
  });

  function renderThumbGrid(){
    const grid = $('#thumbGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const ids = Object.keys(imageMap);
    if (!ids.length){
      grid.innerHTML = '<div class="muted">まだ登録はありません</div>';
      return;
    }
    ids.forEach(id=>{
      const url = imageMap[id];
      const wrap = document.createElement('div');
      wrap.style.border='1px solid #2a3760';
      wrap.style.borderRadius='10px';
      wrap.style.padding='6px';
      wrap.style.background='#0f1630';

      const img = document.createElement('img');
      img.src = url;
      img.style.width='100%';
      img.style.height='80px';
      img.style.objectFit='cover';
      img.title = url;
      img.addEventListener('click', ()=>{
        navigator.clipboard?.writeText(url);
        alert('URLをコピーしました:\n' + url);
      });

      const cap = document.createElement('div');
      cap.className = 'muted';
      cap.style.fontSize='12px';
      cap.style.marginTop='6px';
      cap.textContent = id;

      wrap.appendChild(img);
      wrap.appendChild(cap);
      grid.appendChild(wrap);
    });
  }

  $('#btnReloadProductsForImages')?.addEventListener('click', loadProducts);

  // =========================
  // 既存: Flex生成（画像対応）
  // =========================
  function buildFlex(){
    const hideRaw = ($('#hideIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    const visible = products.filter(p=>!hideRaw.includes(p.id));
    const bubbles = visible.map(p=>{
      const heroUrl = getImageUrlFor(p.id);
      const bodyContents = [
        { type:'text', text:p.name, weight:'bold', size:'md', wrap:true },
        { type:'text', text:`価格：${yen(p.price)}　在庫：${p.stock??0}`, size:'sm', wrap:true }
      ];
      if (p.desc) bodyContents.push({ type:'text', text:p.desc, size:'sm', wrap:true });

      const bubble = {
        type:'bubble',
        ...(heroUrl ? {
          hero: {
            type:'image',
            url: heroUrl,           // HTTPS 公開URL必須
            size:'full',
            aspectMode:'cover',
            aspectRatio:'16:9'
          }
        } : {}),
        body:{ type:'box', layout:'vertical', spacing:'sm', contents: bodyContents },
        footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
          { type:'button', style:'primary',
            action:{ type:'postback', label:'数量を選ぶ', data:`order_qty?id=${encodeURIComponent(p.id)}&qty=1` } }
        ]}
      };
      return bubble;
    });

    // 「その他」ページ
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

  $('#btnBuildFlex')?.addEventListener('click', ()=>{
    if (!products.length) return alert('先に商品を取得してください');
    show($('#flexPreview'), buildFlex());
  });

  // =========================
  // 既存: 配信（Flex）
  // =========================
  $('#btnSendFlex')?.addEventListener('click', async ()=>{
    if (!products.length) return alert('先に商品を取得してください');
    const payload = buildFlex();
    const ids = ($('#userIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    const url = ids.length ? '/api/admin/segment/send-flex' : '/api/admin/broadcast-flex';
    const body = ids.length ? { userIds: ids, altText: payload.altText, contents: payload.contents }
                            : { altText: payload.altText, contents: payload.contents };
    const r = await fetch(url, { method:'POST', headers: auth(), body: JSON.stringify(body) });
    const j = await r.json();
    $('#sendFlexRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
  });

  // =========================
  // 既存: テキスト配信
  // =========================
  $('#btnSendText')?.addEventListener('click', async ()=>{
    const msg = ($('#textMessage').value||'').trim();
    if (!msg) return alert('本文が空です');
    const ids = ($('#textUserIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (ids.length){
      const r = await fetch('/api/admin/segment/send', { method:'POST', headers: auth(), body: JSON.stringify({ userIds: ids, message: msg }) });
      const j = await r.json();
      $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
    } else {
      const r = await fetch('/api/admin/broadcast-flex', {
        method:'POST', headers: auth(),
        body: JSON.stringify({
          altText:'テキスト',
          contents:{ type:'bubble', body:{ type:'box', layout:'vertical', contents:[{ type:'text', text: msg, wrap:true }] } }
        })
      });
      const j = await r.json();
      $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
    }
  });

  // =========================
  // 既存: ユーザー収集
  // =========================
  $('#btnActiveUsers')?.addEventListener('click', async ()=>{
    const r = await fetch('/api/admin/active-chatters?list=true', { headers: auth() });
    const j = await r.json();
    show($('#usersOut'), j);
  });

  // =========================
  // 既存: メッセージログ
  // =========================
  async function loadLog(){
    const r = await fetch('/api/admin/messages?limit=200', { headers: auth() });
    const j = await r.json();
    show($('#logOut'), j);
  }
  $('#btnLoadLog')?.addEventListener('click', loadLog);

  let auto=false, timer=null;
  $('#btnAutoRefresh')?.addEventListener('click', ()=>{
    auto = !auto; $('#autoStatus').textContent = auto ? 'ON' : 'OFF';
    if (auto){ loadLog(); timer = setInterval(loadLog, 10000); } else { clearInterval(timer); }
  });

  // =========================
  // （参考）userId 自動入力の簡易仕上げ
  // =========================
  const LS_UID = "admin_user_ids";
  function saveUid(v){ try{ localStorage.setItem(LS_UID, v) }catch(_){ } }
  function loadUid(){ try{ return localStorage.getItem(LS_UID)||"" }catch(_){ return "" } }
  function applyUid(v){
    if (!v) return;
    const a = $('#userIds'); const b = $('#textUserIds');
    if (a) a.value = v; if (b) b.value = v;
    $('#sendFlexRes')?.textContent = `userId 自動入力: ${v}`;
    $('#sendTextRes')?.textContent = `userId 自動入力: ${v}`;
    saveUid(v);
  }
  // URL ?userId= / ?uid= / ?me=1
  function getUidFromUrl(){
    const u = new URL(location.href);
    const params = ['userId','uid','me'];
    for (const k of params){
      if (u.searchParams.has(k)){
        const v = u.searchParams.get(k);
        if (k==='me' && (v==='1'||v==='true')) return 'me';
        if (v) return v.trim();
      }
    }
    return "";
  }
  document.addEventListener('DOMContentLoaded', ()=>{
    const fromUrl = getUidFromUrl();
    if (fromUrl) return applyUid(fromUrl);
    const saved = loadUid();
    if (saved) applyUid(saved);
  });
})();
