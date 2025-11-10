(function(){
  const $ = (sel)=>document.querySelector(sel);
  const show = (el, data)=>{ el.hidden=false; el.textContent = typeof data==='string' ? data : JSON.stringify(data,null,2); };
  const auth = ()=>({ 'Authorization':'Bearer ' + ($('#token').value||'').trim(), 'Content-Type':'application/json' });

  // 認証・状態
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

  // 商品取得 → Flex生成
  let products = [];
  $('#btnLoadProducts').onclick = async ()=>{
    const r = await fetch('/api/admin/products', { headers: auth() });
    const j = await r.json();
    if (!j.ok) return alert('取得失敗: '+(j.error||''));
    products = j.items||[];
    $('#prodCount').textContent = `取得 ${products.length} 件`;
  };

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
  $('#btnBuildFlex').onclick = ()=>{
    if (!products.length) return alert('先に商品を取得してください');
    show($('#flexPreview'), buildFlex());
  };

  // 配信（Flex）
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

  // テキスト配信
  $('#btnSendText').onclick = async ()=>{
    const msg = ($('#textMessage').value||'').trim();
    if (!msg) return alert('本文が空です');
    const ids = ($('#textUserIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
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

  // ユーザー収集
  $('#btnActiveUsers').onclick = async ()=>{
    const r = await fetch('/api/admin/active-chatters?list=true', { headers: auth() });
    const j = await r.json();
    show($('#usersOut'), j);
  };
// 直近アクティブユーザー → userIds に自動入力
$('#btnSetToUserIds').onclick = ()=>{
  try {
    const txt = $('#usersOut').textContent.trim();
    if (!txt) return alert('先に「直近アクティブユーザー取得」を押してください');

    const data = JSON.parse(txt);

    // data が配列か、 { items:[] } 形式か両対応
    const list = Array.isArray(data) ? data :
      (Array.isArray(data.items) ? data.items :
      (Array.isArray(data.userIds) ? data.userIds : []));

    if (!list.length) return alert('userId が見つかりません');

    $('#userIds').value = list.join(', ');
    alert(`userIds に ${list.length}件 セットしました ✅`);
  } catch(e){
    alert('ログ形式が読み取れません。\n先に「直近アクティブユーザー取得」を押してください。');
  }
};

  // メッセージログ（tail相当）
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
})();
JS
