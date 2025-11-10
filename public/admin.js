<!-- ===== public/admin.js ===== -->
footer:{ type:'box', layout:'vertical', spacing:'md', contents:[
{ type:'button', style:'primary', action:{ type:'postback', label:'商品名を入力する', data:'other_start' } },
{ type:'button', style:'secondary', action:{ type:'postback', label:'← 戻る', data:'order_back' } }
]}
});
return {
type:'flex',
altText: ($('#altText').value||'商品一覧').slice(0,400),
contents: (bubbles.length===1) ? bubbles[0] : { type:'carousel', contents:bubbles }
};
}
$('#btnBuildFlex')?.addEventListener('click', () => {
if (!products.length){ alert('先に商品を取得してください'); return; }
const msg = buildFlexFromProducts(products);
out($('#flexPreview'), msg, true);
});


// セグメント or Broadcast でFlex送信
$('#btnSendFlex')?.addEventListener('click', async () => {
try{
if (!products.length){ alert('先に商品を取得してください'); return; }
const payload = buildFlexFromProducts(products);
const ids = ($('#userIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
const url = ids.length ? '/api/admin/segment/send-flex' : '/api/admin/broadcast-flex';
const body = ids.length ? { userIds: ids, altText: payload.altText, contents: payload.contents } : { altText: payload.altText, contents: payload.contents };
const r = await fetch(url, { method:'POST', headers: hdr(), body: JSON.stringify(body) });
const j = await r.json();
$('#sendFlexRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||'') );
}catch(e){ $('#sendFlexRes').textContent = 'ERR ' + e; }
});


// テキスト送信
$('#btnSendText')?.addEventListener('click', async () => {
const msg = ($('#textMessage').value||'').trim();
if (!msg){ alert('本文が空です'); return; }
const ids = ($('#textUserIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
if (ids.length){
const r = await fetch('/api/admin/segment/send', { method:'POST', headers: hdr(), body: JSON.stringify({ userIds: ids, message: msg }) });
const j = await r.json(); $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
} else {
// テキスト単体の broadcast は SDK 経由にしているため、既存の broadcast-flex API を流用（Bubbleにテキスト一発）
const fakeFlex = { type:'bubble', body:{ type:'box', layout:'vertical', contents:[{ type:'text', text: msg, wrap:true }] } };
const r = await fetch('/api/admin/broadcast-flex', { method:'POST', headers: hdr(), body: JSON.stringify({ altText:'お知らせ', contents: fakeFlex }) });
const j = await r.json(); $('#sendTextRes').textContent = j.ok ? 'OK' : ('NG: ' + (j.error||''));
}
});


// userId 自動取得 → 入力欄に差し込み
async function autofill(targetSel){
const r = await fetch('/api/admin/active-chatters?list=true', { headers: hdr() });
const j = await r.json();
const ids = (j && j.users) ? j.users : [];
$(targetSel).value = ids.join(',');
}
$('#btnAutofillUsers')?.addEventListener('click', () => autofill('#userIds'));
$('#btnAutofillUsers2')?.addEventListener('click', () => autofill('#textUserIds'));


// メッセージログ（tail）
let auto=false, timer=null;
async function loadLog(){
const r = await fetch('/api/admin/messages?limit=200', { headers: hdr() });
const j = await r.json(); out($('#logOut'), j, true);
}
$('#btnLoadLog')?.addEventListener('click', loadLog);
$('#btnAutoRefresh')?.addEventListener('click', () => {
auto = !auto; $('#autoStatus').textContent = auto ? 'ON' : 'OFF';
if (auto){ loadLog(); timer = setInterval(loadLog, 10000); } else { clearInterval(timer); }
});
})();
