const $ = (sel)=>document.querySelector(sel);
const show = (el, data)=>{ el.hidden=false; el.textContent = typeof data==='string'? data : JSON.stringify(data,null,2); };
const hdr = ()=>({ 'Authorization':'Bearer '+(($('#token').value||'').trim()), 'Content-Type':'application/json' });

/* 認証・状態 */
$('#btnPing').onclick = async ()=>{
  $('#pingRes').textContent = '…';
  try{
    const r = await fetch('/api/admin/ping', { headers: hdr() });
    const j = await r.json();
    $('#pingRes').textContent = j.ok? 'OK' : 'NG';
  }catch(e){ $('#pingRes').textContent = 'ERR'; }
};
$('#btnHealth').onclick = async ()=>{
  const r = await fetch('/api/health');
  show($('#healthOut'), await r.json());
};

/* 商品 → Flex 生成 */
let PRODUCTS = [];
$('#btnLoadProducts').onclick = async ()=>{
  const r = await fetch('/api/admin/products', { headers: hdr() });
  const j = await r.json();
  if(!j.ok) return alert('取得失敗: '+(j.error||''));
  PRODUCTS = j.items||[];
  if($('#hideKusuke').checked) PRODUCTS = PRODUCTS.filter(x=>x.id!=='kusuke-250');
  $('#prodCount').textContent = `取得 ${PRODUCTS.length} 件`;
};

const yen = (n)=>`${Number(n||0).toLocaleString('ja-JP')}円`;
function buildFlex(list){
  const bubbles = list.map(p=>({
    type:'bubble',
    body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
      { type:'text', text:p.name, weight:'bold', size:'md', wrap:true },
      { type:'text', text:`価格：${yen(p.price)}　在庫：${p.stock??0}`, size:'sm', wrap:true },
      p.desc? { type:'text', text:p.desc, size:'sm', wrap:true } : { type:'box', layout:'vertical', contents:[] }
    ]},
    footer:{ type:'box', layout:'horizontal', spacing:'md', contents:[
      { type:'button', style:'primary', action:{ type:'postback', label:'数量を選ぶ', data:`order_qty?id=${encodeURIComponent(p.id)}&qty=1` } }
    ]}
  }));
  // その他（自由入力）
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
  return { type:'flex', altText: ($('#altText').value||'商品一覧').slice(0,400), contents:(bubbles.length===1? bubbles[0] : { type:'carousel', contents:bubbles }) };
}

$('#btnBuildFlex').onclick = ()=>{
  if(!PRODUCTS.length) return alert('先に商品を読み込んでください');
  const msg = buildFlex(PRODUCTS);
  show($('#flexPreview'), msg);
};

/* 配信（Flex） */
$('#btnSendFlex').onclick = async ()=>{
  if(!PRODUCTS.length) return alert('先に商品を読み込んでください');
  const msg = buildFlex(PRODUCTS);
  const ids = ($('#userIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
  const url = ids.length? '/api/admin/segment/send-flex' : '/api/admin/broadcast-flex';
  const body = ids.length? { userIds: ids, altText: msg.altText, contents: msg.contents } : { altText: msg.altText, contents: msg.contents };
  const r = await fetch(url, { method:'POST', headers: hdr(), body: JSON.stringify(body) });
  const j = await r.json();
  $('#sendFlexRes').textContent = j.ok? 'OK' : ('NG: '+(j.error||'')); 
};

/* セグメント userId を自動入力（直近アクティブ） */
$('#btnFillActive').onclick = async ()=>{
  const r = await fetch('/api/admin/active-chatters?list=true', { headers: hdr() });
  const j = await r.json();
  const list = Array.isArray(j.users)? j.users : [];
  if(!list.length) return alert('直近のユーザーが見つかりません');
  $('#userIds').value = list.join(',');
  alert(`${list.length}件を userIds にセットしました`);
};

/* テキスト配信 */
$('#btnSendText').onclick = async ()=>{
  const msg = ($('#textMessage').value||'').trim();
  if(!msg) return alert('本文が空です');
  const ids = ($('#textUserIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(ids.length){
    const r = await fetch('/api/admin/segment/send', { method:'POST', headers: hdr(), body: JSON.stringify({ userIds: ids, message: msg }) });
    const j = await r.json(); $('#sendTextRes').textContent = j.ok? 'OK' : ('NG: '+(j.error||'')); 
  }else{
    // テキストは broadcast の簡易代替として Flexに詰めて送る
    const bubble = { type:'bubble', body:{ type:'box', layout:'vertical', contents:[{ type:'text', text: msg, wrap:true }] } };
    const r = await fetch('/api/admin/broadcast-flex', { method:'POST', headers: hdr(), body: JSON.stringify({ altText:'テキスト', contents:bubble }) });
    const j = await r.json(); $('#sendTextRes').textContent = j.ok? 'OK' : ('NG: '+(j.error||'')); 
  }
};

/* メッセージログ（tail） */
let auto=false, timer=null;
async function loadLog(){
  const r = await fetch('/api/admin/messages?limit=200', { headers: hdr() });
  const j = await r.json(); show($('#logOut'), j);
}
$('#btnLoadLog').onclick = loadLog;
$('#btnAutoRefresh').onclick = ()=>{
  auto = !auto; $('#autoStatus').textContent = auto? 'ON':'OFF';
  if(auto){ loadLog(); timer=setInterval(loadLog, 10000); } else { clearInterval(timer); }
};

})();
