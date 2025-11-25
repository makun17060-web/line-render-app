// /public/confirm.js
// ONLINE の confirm。住所がなければ liff-address.html へ。

(async function(){
  const itemsBox = document.getElementById("itemsBox");
  const addressBox = document.getElementById("addressBox");
  const totalsBox = document.getElementById("totalsBox");
  const addrBtn = document.getElementById("addrBtn");
  const payBtn = document.getElementById("payBtn");
  const backBtn = document.getElementById("backBtn");
  const statusMsg = document.getElementById("statusMsg");

  let lineUserId=""; let lineUserName="";

  async function initLiff(){
    try{
      const confRes = await fetch("/api/liff/config?kind=online", { cache:"no-store" });
      const conf = await confRes.json();
      const liffId = (conf?.liffId||"").trim();
      if(!liffId) throw new Error("no liffId online");
      await liff.init({ liffId });
      if(!liff.isLoggedIn()){ liff.login(); return false; }
      const prof = await liff.getProfile();
      lineUserId = prof.userId;
      lineUserName = prof.displayName;
      return true;
    }catch(e){
      statusMsg.textContent="LIFF初期化に失敗。LINEアプリから開いてください。";
      return false;
    }
  }
  const ok = await initLiff(); if(!ok) return;

  const cur = JSON.parse(sessionStorage.getItem("currentOrder")||"{}");
  if(!Array.isArray(cur.items) || cur.items.length===0){
    location.href="/public/products.html"; return;
  }
  cur.lineUserId=lineUserId; cur.lineUserName=lineUserName;

  async function loadAddress(){
    try{
      const res = await fetch(`/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`, { cache:"no-store" });
      const data = await res.json();
      return data?.address || null;
    }catch{ return null; }
  }

  const savedAddr = await loadAddress();
  if(savedAddr) cur.address = savedAddr;
  sessionStorage.setItem("currentOrder", JSON.stringify(cur));

  // items描画
  const itemsTotal = cur.items.reduce((s,it)=>s+(it.price*it.qty),0);
  itemsBox.innerHTML = cur.items.map(it=>`
    <div class="row"><div>${it.name} x ${it.qty}</div><div>${it.price*it.qty}円</div></div>
  `).join("") + `<hr><div class="row"><b>商品合計</b><b>${itemsTotal}円</b></div>`;

  // address描画
  if(cur.address){
    const a=cur.address;
    addressBox.innerHTML = `
      <b>お届け先</b><br>
      ${a.postal||""} ${a.prefecture||""}${a.city||""}${a.address1||""} ${a.address2||""}<br>
      ${a.name||""} / ${a.phone||""}
    `;
  }else{
    addressBox.innerHTML = `<b>お届け先</b><br>未登録です。住所入力ボタンから登録してください。`;
  }

  // 送料計算
  const shipRes = await fetch("/api/shipping", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ items: cur.items, address: cur.address||{} })
  });
  const ship = await shipRes.json();
  const shipping = Number(ship.shipping||0);
  const finalTotal = Number(ship.finalTotal||itemsTotal);

  totalsBox.innerHTML = `
    <div class="row"><div>送料</div><div>${shipping}円</div></div>
    <div class="row"><b>合計</b><b>${finalTotal}円</b></div>
  `;

  addrBtn.onclick = ()=>{
    location.href="/public/liff-address.html";
  };

  backBtn.onclick = ()=>{
    location.href="/public/products.html";
  };

  payBtn.onclick = async ()=>{
    if(!cur.address){
      statusMsg.textContent="住所が未登録です。住所入力を開いてください。";
      return;
    }
    statusMsg.textContent="決済準備中…";

    const res = await fetch("/api/pay", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        items: cur.items,
        total: finalTotal,
        lineUserId,
        lineUserName
      })
    });

    const data = await res.json();
    if(!data?.ok || !data.redirectUrl){
      statusMsg.textContent="決済開始に失敗しました。";
      return;
    }
    location.href = data.redirectUrl;
  };
})();
