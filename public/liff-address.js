// /public/liff-address.js
// ONLINE注文用住所入力（LIFF内）。

(async function(){
  const $ = (id)=>document.getElementById(id);
  const postal=$("postal"), prefecture=$("prefecture"), city=$("city"),
        address1=$("address1"), address2=$("address2"),
        name=$("name"), phone=$("phone");
  const saveBtn=$("saveBtn"), backBtn=$("backBtn"), statusMsg=$("statusMsg");

  let lineUserId="", lineUserName="";

  async function initLiff(){
    try{
      const confRes = await fetch("/api/liff/config?kind=online", { cache:"no-store" });
      const conf = await confRes.json();
      const liffId = (conf?.liffId||"").trim();
      if(!liffId) throw new Error("no liffId online");
      await liff.init({ liffId });
      if(!liff.isLoggedIn()){ liff.login(); return false; }
      const prof=await liff.getProfile();
      lineUserId=prof.userId; lineUserName=prof.displayName;
      return true;
    }catch(e){
      statusMsg.textContent="LIFF初期化に失敗しました。LINEアプリから開いてください。";
      return false;
    }
  }
  const ok=await initLiff(); if(!ok||!lineUserId) return;

  async function loadAddress(){
    try{
      const res=await fetch(`/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`, { cache:"no-store" });
      const data=await res.json();
      return data?.address||null;
    }catch{ return null; }
  }

  const saved = await loadAddress();
  if(saved){
    postal.value=saved.postal||"";
    prefecture.value=saved.prefecture||"";
    city.value=saved.city||"";
    address1.value=saved.address1||"";
    address2.value=saved.address2||"";
    name.value=saved.name||lineUserName||"";
    phone.value=saved.phone||"";
  }else{
    name.value=lineUserName||"";
  }

  saveBtn.onclick = async ()=>{
    const addr={
      userId: lineUserId,
      postal: postal.value.trim(),
      prefecture: prefecture.value.trim(),
      city: city.value.trim(),
      address1: address1.value.trim(),
      address2: address2.value.trim(),
      name: name.value.trim(),
      phone: phone.value.trim(),
    };

    if(!addr.postal||!addr.prefecture||!addr.city||!addr.address1||!addr.name||!addr.phone){
      statusMsg.textContent="未入力の項目があります。すべて入力してください。";
      return;
    }

    saveBtn.disabled=true;
    statusMsg.textContent="保存中…";

    try{
      const res=await fetch("/api/liff/address",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(addr)
      });
      const data=await res.json();
      if(!data?.ok) throw new Error("save failed");

      const cur=JSON.parse(sessionStorage.getItem("currentOrder")||"{}");
      cur.address=addr;
      cur.lineUserId=lineUserId; cur.lineUserName=lineUserName;
      sessionStorage.setItem("currentOrder", JSON.stringify(cur));

      statusMsg.textContent="住所を保存しました。確認画面へ戻ります…";
      setTimeout(()=> location.href="/public/confirm.html", 600);
    }catch(e){
      statusMsg.textContent="保存に失敗しました。通信環境を確認してください。";
      saveBtn.disabled=false;
    }
  };

  backBtn.onclick = ()=> location.href="/public/confirm.html";
})();
