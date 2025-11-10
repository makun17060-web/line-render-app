const $ = (sel)=>document.querySelector(sel);
const show = (el,data)=>{el.hidden=false;el.textContent=typeof data==="string"?data:JSON.stringify(data,null,2)};
const hdr = ()=>({"Authorization":"Bearer "+($('#token').value||'').trim(),"Content-Type":"application/json"});

/* Ping / Health */
$('#btnPing').onclick = async ()=>{
  const r = await fetch('/api/admin/ping',{headers:hdr()});
  const j = await r.json();
  $('#pingRes').textContent = j.ok?"OK":"NG";
};

$('#btnHealth').onclick = async ()=>{
  const r = await fetch('/api/health');
  show($('#healthOut'), await r.json());
};

/* 商品 → Flex */
let PRODUCTS=[];
$('#btnLoadProducts').onclick = async ()=>{
  const r = await fetch('/api/admin/products',{headers:hdr()});
  const j = await r.json();
  PRODUCTS = j.items||[];
  if($('#hideKusuke').checked) PRODUCTS = PRODUCTS.filter(x=>x.id!=='kusuke-250');
  $('#prodCount').textContent = `取得 ${PRODUCTS.length} 件`;
};

const yen = n=>`${Number(n||0).toLocaleString('ja-JP')}円`;

function buildFlex(){
  const bubbles = PRODUCTS.map(p=>({
    type:"bubble",
    body:{type:"box",layout:"vertical",spacing:"sm",contents:[
      {type:"text",text:p.name,weight:"bold",size:"md",wrap:true},
      {type:"text",text:`価格：${yen(p.price)}　在庫：${p.stock??0}`,size:"sm",wrap:true},
      p.desc?{type:"text",text:p.desc,size:"sm",wrap:true}:{type:"box",layout:"vertical",contents:[]}
    ]},
    footer:{type:"box",layout:"horizontal",spacing:"md",contents:[
      {type:"button",style:"primary",action:{type:"postback",label:"数量を選ぶ",data:`order_qty?id=${encodeURIComponent(p.id)}&qty=1`}}
    ]}
  }));

  bubbles.push({
    type:"bubble",
    body:{type:"box",layout:"vertical",spacing:"sm",contents:[
      {type:"text",text:"その他（自由入力）",weight:"bold",size:"md"},
      {type:"text",text:"商品名と個数だけ入力します。価格入力は不要です。",size:"sm",wrap:true}
    ]},
    footer:{type:"box",layout:"vertical",spacing:"md",contents:[
      {type:"button",style:"primary",action:{type:"postback",label:"商品名を入力する",data:"other_start"}},
      {type:"button",style:"secondary",action:{type:"postback",label:"← 戻る",data:"order_back"}}
    ]}
  });

  return {type:"flex",altText:($('#altText').value||"商品一覧").slice(0,400),
    contents:(bubbles.length===1?bubbles[0]:{type:"carousel",contents:bubbles})};
}

$('#btnBuildFlex').onclick = ()=> show($('#flexPreview'), buildFlex());

/* セグメント userId 自動入力 */
$('#btnFillActive').onclick = async ()=>{
  const r = await fetch('/api/admin/active-chatters?list=true',{headers:hdr()});
  const j = await r.json();
  const list = j.users||[];
  if(!list.length) return alert("直近のユーザーがいません");
  $('#userIds').value = list.join(',');
  alert(`${list.length} 件 userIds にセットしました`);
};

/* Flex 配信 */
$('#btnSendFlex').onclick = async ()=>{
  const msg = buildFlex();
  const ids = ($('#userIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
  const url = ids.length?'/api/admin/segment/send-flex':'/api/admin/broadcast-flex';
  const body = ids.length?{userIds:ids,altText:msg.altText,contents:msg.contents}:{altText:msg.altText,contents:msg.contents};
  const r = await fetch(url,{method:"POST",headers:hdr(),body:JSON.stringify(body)});
  const j = await r.json();
  $('#sendFlexRes').textContent=j.ok?"OK":("NG:"+j.error);
};

/* テキスト配信 */
$('#btnSendText').onclick = async ()=>{
  const msg = ($('#textMessage').value||'').trim();
  if(!msg) return alert("本文が空です");
  const ids = ($('#textUserIds').value||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(ids.length){
    const r = await fetch('/api/admin/segment/send',{method:"POST",headers:hdr(),body:JSON.stringify({userIds:ids,message:msg})});
    const j = await r.json(); $('#sendTextRes').textContent=j.ok?"OK":("NG:"+j.error);
  }else{
    const bubble={type:"bubble",body:{type:"box",layout:"vertical",contents:[{type:"text",text:msg,wrap:true}]}};
    const r = await fetch('/api/admin/broadcast-flex',{method:"POST",headers:hdr(),body:JSON.stringify({altText:"お知らせ",contents:bubble})});
    const j = await r.json(); $('#sendTextRes').textContent=j.ok?"OK":("NG:"+j.error);
  }
};

/* メッセージログ */
let auto=false,timer=null;
async function loadLog(){
  const r = await fetch('/api/admin/messages?limit=200',{headers:hdr()});
  const j = await r.json();
  show($('#logOut'),j);
}

$('#btnLoadLog').onclick = loadLog;
$('#btnAutoRefresh').onclick = ()=>{
  auto=!auto; $('#autoStatus').textContent=auto?"ON":"OFF";
  if(auto){loadLog();timer=setInterval(loadLog,10000);}else{clearInterval(timer);}
};

})();
JS
