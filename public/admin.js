// admin.js — 管理画面＋userId自動入力 〈丸ごと版〉
(function(){
  const $ = (sel)=>document.querySelector(sel);
  const show = (el, data)=>{ el.hidden=false; el.textContent = typeof data==='string' ? data : JSON.stringify(data,null,2); };
  const auth = ()=>({ 'Authorization':'Bearer ' + (($('#token')?.value)||'').trim(), 'Content-Type':'application/json' });

  // 認証・状態
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

  // 商品取得 → Flex生成
  let products = [];
  $('#btnLoadProducts')?.addEventListener('click', async ()=>{
    const r = await fetch('/api/admin/products', { headers: auth() });
    const j = await r.json();
    if (!j.ok) return alert('取得失敗: '+(j.error||''));
    products = j.items||[];
    $('#prodCount').textContent = `取得 ${products.length} 件`;
  });

  function yen(n){ return Number(n||0).toLocaleString('ja-JP')+'円'; }
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
  $('#btnBuildFlex')?.addEventListener('click', ()=>{
    if (!products.length) return alert('先に商品を取得してください');
    show($('#flexPreview'), buildFlex());
  });

  // 配信（Flex）
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

  // テキスト配信
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
        body: JSON.stringify({ altText:'テキスト', contents:{ type:'bubble', body:{ type:'box', layout:'vertical', contents:[{ type:'text', text: msg, wrap:true }] } } })
      });
      const j = await r.json();
      $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));  
    }
  });

  // ユーザー収集
  $('#btnActiveUsers')?.addEventListener('click', async ()=>{
    const r = await fetch('/api/admin/active-chatters?list=true', { headers: auth() });
    const j = await r.json();
    show($('#usersOut'), j);
  });

  // メッセージログ（tail相当）
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
})();

// ====== ここから：userId 自動入力 IIFE（<script>タグは不要！） ======
(function(){
  // ページ内の userId 入力欄（Flex送信用 / テキスト送信用）
  const USER_IDS_INPUT_SELECTOR = "#userIds";
  const TEXT_USER_IDS_INPUT_SELECTOR = "#textUserIds";

  // URLパラメータ名: ?userId= / ?uid= / ?me=1 もOK
  const PARAM_NAMES = ["userId", "uid", "me"];

  // ローカル保存キー
  const LS_KEY = "admin_user_ids";

  const $ = (sel) => document.querySelector(sel);
  const setIfExists = (sel, value) => { const el = $(sel)
