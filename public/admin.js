(function(){
  const $ = (sel)=>document.querySelector(sel);
  const $$ = (sel)=>Array.from(document.querySelectorAll(sel));
  const show = (el, data)=>{ el.hidden=false; el.textContent = typeof data==='string' ? data : JSON.stringify(data,null,2); };
  const auth = ()=>({ 'Authorization':'Bearer ' + ($('#token').value||'').trim(), 'Content-Type':'application/json' });

  // ========= 認証・状態 =========
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

  // ========= 商品取得・表示 =========
  let products = [];
  const grid = $('#productsGrid');

  function yen(n){ return Number(n||0).toLocaleString('ja-JP')+'円'; }

  function renderProducts(){
    grid.innerHTML = '';
    products.forEach(p=>{
      const card = document.createElement('div');
      card.className = 'prod';
      card.dataset.id = p.id;

      const imgUrl = p.image || '';
      card.innerHTML = `
        <h3>${p.name}</h3>
        <div class="mini">ID: <code class="inline">${p.id}</code></div>
        <div class="mini">価格：${yen(p.price)}　在庫：${p.stock ?? 0}</div>
        <img class="thumb" alt="image" src="${imgUrl || ''}" ${imgUrl?'':'style="display:none"'} />
        <div class="drop" tabindex="0">ここに画像をドラッグ＆ドロップ、またはクリックして選択</div>
        <div class="row">
          <input class="imgUrl" type="text" placeholder="画像URL（手動で貼る場合）" value="${imgUrl}">
        </div>
        <div class="row">
          <button class="secondary saveImg">画像URLを保存</button>
          <span class="mini status"></span>
        </div>
      `;
      grid.appendChild(card);

      const drop = card.querySelector('.drop');
      const thumb = card.querySelector('.thumb');
      const urlInput = card.querySelector('.imgUrl');
      const status = card.querySelector('.status');
      const saveBtn = card.querySelector('.saveImg');

      // 画像プレビューの更新
      const applyThumb = (url)=>{
        if (url) {
          thumb.src = url;
          thumb.style.display = '';
          urlInput.value = url;
        }
      };

      // 直接URL保存
      saveBtn.onclick = async ()=>{
        const url = (urlInput.value||'').trim();
        if(!url) return alert('画像URLを入力してください');
        status.textContent = '保存中...';
        try{
          const r = await fetch('/api/admin/products/set-image',{
            method:'POST',
            headers: auth(),
            body: JSON.stringify({ productId: p.id, image: url })
          });
          const j = await r.json();
          if(!j.ok) throw new Error(j.error||'save_failed');
          status.textContent = '✓ 保存しました'; status.className='mini ok';
          applyThumb(url);
          // ローカルの products も更新
          const idx = products.findIndex(x=>x.id===p.id);
          if (idx>=0) products[idx].image = url;
        }catch(e){
          status.textContent = '✗ 保存失敗: '+e.message; status.className='mini ng';
        }
      };

      // D&D/クリック → アップロード
      const pickFile = ()=>{
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'image/*';
        inp.onchange = ()=>{ if(inp.files && inp.files[0]) uploadFile(inp.files[0]); };
        inp.click();
      };

      const uploadFile = async (file)=>{
        if(!file) return;
        const t = ($('#token').value||'').trim();
        if(!t) return alert('ADMIN_API_TOKEN を入力してください');

        status.textContent = 'アップロード中...'; status.className='mini';
        try{
          const fd = new FormData();
          fd.append('image', file);
          fd.append('productId', p.id);

          const r = await fetch('/api/admin/upload-image', {
            method:'POST',
            headers: { 'Authorization':'Bearer '+t }, // FormData のときは Content-Type 付けない
            body: fd
          });
          // たまに HTML が返ってきて JSON.parse が落ちることがあるので保険
          const text = await r.text();
          let j;
          try{ j = JSON.parse(text); }catch{
            throw new Error('サーバーがJSONを返しませんでした: '+text.slice(0,120));
          }
          if(!j.ok) throw new Error(j.error||'upload_failed');

          const url = j.url; // 例：/uploads/abc123.png
          applyThumb(url);
          urlInput.value = url;

          // 画像URLを products に保存
          const r2 = await fetch('/api/admin/products/set-image',{
            method:'POST',
            headers: auth(),
            body: JSON.stringify({ productId: p.id, image: url })
          });
          const j2 = await r2.json();
          if(!j2.ok) throw new Error(j2.error||'save_failed');

          status.textContent = '✓ 画像を登録しました'; status.className='mini ok';

          // ローカルの products も更新
          const idx = products.findIndex(x=>x.id===p.id);
          if (idx>=0) products[idx].image = url;

        }catch(e){
          status.textContent = '✗ アップロード失敗: '+e.message; status.className='mini ng';
        }
      };

      // D&Dイベント
      const enter = (e)=>{ e.preventDefault(); drop.classList.add('drag'); };
      const over  = (e)=>{ e.preventDefault(); };
      const leave = (e)=>{ drop.classList.remove('drag'); };
      const dropH = (e)=>{
        e.preventDefault(); drop.classList.remove('drag');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) uploadFile(f);
      };
      drop.addEventListener('dragenter', enter);
      drop.addEventListener('dragover', over);
      drop.addEventListener('dragleave', leave);
      drop.addEventListener('drop', dropH);
      drop.addEventListener('click', pickFile);
      drop.addEventListener('keypress', (e)=>{ if(e.key==='Enter' || e.key===' ') pickFile(); });
    });
  }

  $('#btnLoadProducts').onclick = async ()=>{
    try{
      const r = await fetch('/api/admin/products', { headers: auth() });
      const j = await r.json();
      if (!j.ok) return alert('取得失敗: '+(j.error||''));
      products = j.items||[];
      $('#prodCount').textContent = `取得 ${products.length} 件`;
      renderProducts();
      // ついでに直近アクティブユーザーも候補に入れる（datalist）
      try{ await loadActiveUsersToDatalist(); }catch{}
    }catch(e){ alert('ERR '+e.message); }
  };

  // ========= Flex生成 =========
  function buildFlex(){
    const hideRaw = ($('#hideIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    const visible = products.filter(p=>!hideRaw.includes(p.id));
    const bubbles = visible.map(p=>{
      const bodyContents = [];
      if (p.image) {
        // 画像を hero に
        // hero は body 外のトップ画像。代わりに body に image を入れてもOK
      }
      const bubble = {
        type:'bubble',
        hero: p.image ? { type:'image', url:p.image, size:'full', aspectRatio:'16:9', aspectMode:'cover' } : undefined,
        body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
          { type:'text', text:p.name, weight:'bold', size:'md', wrap:true },
          { type:'text', text:`価格：${yen(p.price)}　在庫：${p.stock??0}`, size:'sm', wrap:true },
          p.desc ? { type:'text', text:p.desc, size:'sm', wrap:true } : { type:'box', layout:'vertical', contents:[] }
        ]},
        footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
          { type:'button', style:'primary', action:{ type:'postback', label:'数量を選ぶ', data:`order_qty?id=${encodeURIComponent(p.id)}&qty=1` } }
        ]}
      };
      if (!p.image) delete bubble.hero;
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
    show($('#flexPreview'), buildFlex());
  };

  // ========= 配信 =========
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

  $('#btnSendText').onclick = async ()=>{
    const msg = ($('#textMessage').value||'').trim();
    if (!msg) return alert('本文が空です');
    const ids = ($('#textUserIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (ids.length){
      const r = await fetch('/api/admin/segment/send', { method:'POST', headers: auth(), body: JSON.stringify({ userIds: ids, message: msg }) });
      const j = await r.json();
      $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));      
    } else {
      // broadcast は Flex に包んで送る
      const r = await fetch('/api/admin/broadcast-flex', {
        method:'POST', headers: auth(),
        body: JSON.stringify({ altText:'テキスト', contents:{ type:'bubble', body:{ type:'box', layout:'vertical', contents:[{ type:'text', text: msg, wrap:true }] } } })
      });
      const j = await r.json();
      $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
    }
  };

  // ========= 直近アクティブユーザー（datalist化も） =========
  async function loadActiveUsersToDatalist(){
    const r = await fetch('/api/admin/active-chatters?list=true', { headers: auth() });
    const j = await r.json();
    const pre = $('#usersOut');
    show(pre, j);
    const dl = $('#uidList');
    dl.innerHTML = '';
    if (Array.isArray(j.users)) {
      j.users.forEach(uid=>{
        const opt = document.createElement('option');
        opt.value = uid;
        dl.appendChild(opt);
      });
    }
  }
  $('#btnActiveUsers').onclick = loadActiveUsersToDatalist;

  // ========= メッセージログ =========
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

  // ========= userId 自動入力（URL/Local/LIFF/whoami） =========
  (function(){
    const USER_IDS_INPUT_SELECTOR = "#userIds";
    const TEXT_USER_IDS_INPUT_SELECTOR = "#textUserIds";
    const PARAM_NAMES = ["userId","uid","me"];
    const LS_KEY = "admin_user_ids";
    const setIfExists = (sel, v)=>{ const el=$(sel); if(el&&v) el.value=v; };
    const saveLocal = (v)=>{ try{ localStorage.setItem(LS_KEY, v); }catch{} };
    const loadLocal = ()=>{ try{ return localStorage.getItem(LS_KEY)||""; }catch{ return ""; } };
    const getFromUrl = ()=>{
      const u = new URL(location.href);
      for (const k of PARAM_NAMES){
        if (u.searchParams.has(k)){
          const v = u.searchParams.get(k);
          if (k==="me" && (v==="1"||v==="true")) return "me";
          if (v) return v.trim();
        }
      }
      const hash=(u.hash||"").replace(/^#/,"");
      const parts=new URLSearchParams(hash);
      for(const k of PARAM_NAMES){
        if(parts.has(k)){
          const v=parts.get(k);
          if (k==="me" && (v==="1"||v==="true")) return "me";
          if (v) return v.trim();
        }
      }
      return "";
    };
    const applyUserIds = (ids)=>{
      setIfExists(USER_IDS_INPUT_SELECTOR, ids);
      setIfExists(TEXT_USER_IDS_INPUT_SELECTOR, ids);
      saveLocal(ids);
      const a=$('#sendFlexRes'); if (a&&ids) a.textContent=`userId 自動入力: ${ids}`;
      const b=$('#sendTextRes'); if (b&&ids) b.textContent=`userId 自動入力: ${ids}`;
    };
    const tryLiff = async ()=>{
      const liffId = document.body?.dataset?.liffId;
      if(!liffId) return "";
      try{
        if(typeof window.liff==="undefined"){
          await new Promise((resolve,reject)=>{
            const s=document.createElement("script"); s.src="https://static.line-scdn.net/liff/edge/2/sdk.js";
            s.onload=resolve; s.onerror=reject; document.head.appendChild(s);
          });
        }
        await liff.init({ liffId });
        if(!liff.isLoggedIn()){ liff.login({}); return ""; }
        try{ const prof=await liff.getProfile(); if(prof?.userId) return prof.userId; }catch{}
        try{ const tok=liff.getDecodedIDToken(); if(tok?.sub) return tok.sub; }catch{}
      }catch{ }
      return "";
    };
    const tryWhoAmI = async ()=>{
      try{
        const r=await fetch("/api/admin/whoami",{ credentials:"include" });
        if(!r.ok) return "";
        const j=await r.json();
        if(j?.userId) return j.userId;
      }catch{}
      return "";
    };

    document.addEventListener("DOMContentLoaded", async ()=>{
      let c=getFromUrl();
      if(c){ applyUserIds(c==="me"?"me":c); return; }
      c=loadLocal();
      if(c){ applyUserIds(c); }
      const fromLiff=await tryLiff(); if(fromLiff){ applyUserIds(fromLiff); return; }
      const fromApi=await tryWhoAmI(); if(fromApi){ applyUserIds(fromApi); return; }

      // ここまでで入らなければ手入力/候補（datalist）で補助
    });

    // 入力を保存
    const hook=(sel)=>{ const el=$(sel); if(!el) return; el.addEventListener("input", ()=>saveLocal(el.value.trim())); };
    hook(USER_IDS_INPUT_SELECTOR); hook(TEXT_USER_IDS_INPUT_SELECTOR);
  })();
})();
