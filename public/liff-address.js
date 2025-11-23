// /public/liff-address.js
// ② 住所入力画面
// - LIFFで userId を取得
// - /api/liff/address に保存
// - sessionStorage.currentOrder.address にも反映
// - 成功したら confirm.html へ戻す

(async function(){
  const $ = (id)=>document.getElementById(id);

  const postal = $("postal");
  const prefecture = $("prefecture");
  const city = $("city");
  const address1 = $("address1");
  const address2 = $("address2");
  const name = $("name");
  const phone = $("phone");
  const saveBtn = $("saveBtn");
  const backBtn = $("backBtn");
  const statusMsg = $("statusMsg");

  function setStatus(msg){ statusMsg.textContent = msg || ""; }

  function readOrder(){
    try { return JSON.parse(sessionStorage.getItem("currentOrder") || "{}"); }
    catch { return {}; }
  }
  function writeOrder(o){
    sessionStorage.setItem("currentOrder", JSON.stringify(o||{}));
  }

  let lineUserId = "";
  let lineUserName = "";

  async function initLiff(){
    try{
      const confRes = await fetch("/api/liff/config", { cache:"no-store" });
      const conf = await confRes.json();
      const liffId = (conf?.liffId || "").trim();
      if(!liffId){
        setStatus("LIFF ID が取得できません。server.js の /api/liff/config を確認してください。");
        return false;
      }

      await liff.init({ liffId });

      if(!liff.isLoggedIn()){
        liff.login();
        return false;
      }

      const prof = await liff.getProfile();
      lineUserId = prof.userId || "";
      lineUserName = prof.displayName || "";
      return !!lineUserId;
    }catch(e){
      console.log("LIFF init error:", e);
      setStatus("LINEアプリ内で開いてください。\n（ブラウザだと保存できません）");
      return false;
    }
  }

  // 初期化
  const ok = await initLiff();
  if(!ok){
    saveBtn.disabled = true;
  }

  // 保存処理
  async function saveAddress(){
    try{
      if(!lineUserId){
        setStatus("ユーザーIDが取得できません。\nLINEアプリ内で開き直してください。");
        return;
      }

      const addr = {
        userId: lineUserId,
        name: name.value.trim(),
        phone: phone.value.trim(),
        postal: postal.value.trim(),
        prefecture: prefecture.value.trim(),
        city: city.value.trim(),
        address1: address1.value.trim(),
        address2: address2.value.trim()
      };

      if(!addr.postal || !addr.prefecture || !addr.city || !addr.address1 || !addr.name || !addr.phone){
        setStatus("未入力の項目があります。全部入力してください。");
        return;
      }

      saveBtn.disabled = true;
      setStatus("保存中...");

      const res = await fetch("/api/liff/address", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(addr)
      });
      const data = await res.json();

      if(!data?.ok){
        throw new Error(data?.error || "save_failed");
      }

      // currentOrder に住所保存
      const order = readOrder();
      order.address = addr;
      order.lineUserId = lineUserId;
      order.lineUserName = lineUserName;
      writeOrder(order);

      setStatus("住所を保存しました！\n最終確認へ戻ります...");
      location.href = "/public/confirm.html";

    }catch(e){
      console.log(e);
      setStatus("保存に失敗しました。\n通信状況をご確認ください。\n" + (e?.message||""));
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener("click", saveAddress);

  // 戻る
  backBtn.addEventListener("click", ()=>{
    location.href = "/public/confirm.html";
  });

})();
