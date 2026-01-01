(function(){
  "use strict";

  const orderListEl = document.getElementById("orderList");
  const sumSubtotalEl = document.getElementById("sumSubtotal");
  const sumShippingEl = document.getElementById("sumShipping");
  const sumCodEl = document.getElementById("sumCod");
  const sumTotalCardEl = document.getElementById("sumTotalCard");
  const sumTotalCodEl = document.getElementById("sumTotalCod");
  const statusEl = document.getElementById("statusMsg");

  const btnAddress = document.getElementById("btnAddress");
  const btnCard = document.getElementById("btnCard");
  const btnCod = document.getElementById("btnCod");
  const btnBack = document.getElementById("btnBack");

  const COD_FEE = 330;

  const yen = (n)=> (Number(n||0)).toLocaleString("ja-JP") + "円";

  function setStatus(msg){
    if(!msg){
      statusEl.style.display="none";
      statusEl.textContent="";
      return;
    }
    statusEl.style.display="block";
    statusEl.textContent=msg;
  }

  function readDraft(){
    const raw = sessionStorage.getItem("isoya_checkout_v1");
    if(!raw) return null;
    try{ return JSON.parse(raw); }catch{ return null; }
  }

  function escapeHtml(s){
    return String(s ?? "")
      .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
      .replaceAll('"',"&quot;").replaceAll("'","&#039;");
  }

  function renderItems(items){
    orderListEl.innerHTML = items.map(it=>{
      const name = escapeHtml(it.name || it.id || "商品");
      const qty = Number(it.qty||0);
      const price = Number(it.price||0);
      const line = price * qty;
      return `<div class="row"><span>${name} × ${qty}</span><strong>${yen(line)}</strong></div>`;
    }).join("");
  }

  function getUserIdMaybe(){
    // LIFF環境なら liff.getProfile などで userId を取る設計が本筋
    // 本番は“設定済み”と言っているので、ここは既にどこかで保存されている想定に寄せる
    // 例：address.html 側で保存した userId を使う
    return (localStorage.getItem("isoya_user_id") || "").trim();
  }

  function openAddress(){
    // あなたの運用の住所登録LIFFページに合わせて変更
    // server側で /public/liff-address.html を置いている想定
    location.href = "/public/liff-address.html";
  }

  async function callCheckout(items){
    const userId = getUserIdMaybe();
    if(!userId){
      throw new Error("LIFFのuserIdが未保存です。先に住所登録（LIFF）を開いてください。");
    }
    const payload = {
      userId,
      items: items.map(it=>({ id: it.id, qty: Number(it.qty||0) }))
    };
    const res = await fetch("/api/checkout", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(()=> ({}));
    if(!res.ok || !data.ok){
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.detail = data;
      throw err;
    }
    return data; // {checkoutUrl, orderId, subtotal, shippingFee, size}
  }

  async function callCod(items){
    const userId = getUserIdMaybe();
    if(!userId){
      throw new Error("LIFFのuserIdが未保存です。先に住所登録（LIFF）を開いてください。");
    }
    const payload = {
      userId,
      items: items.map(it=>({ id: it.id, qty: Number(it.qty||0) }))
    };
    const res = await fetch("/api/cod/create", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(()=> ({}));
    if(!res.ok || !data.ok){
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.detail = data;
      throw err;
    }
    return data; // {orderId, subtotal, shippingFee, codFee, totalCod}
  }

  async function main(){
    const draft = readDraft();
    if(!draft || !Array.isArray(draft.items) || draft.items.length===0){
      setStatus("注文情報が見つかりません。商品一覧からやり直してください。");
      btnCard.classList.add("disabled"); btnCard.disabled = true;
      btnCod.classList.add("disabled"); btnCod.disabled = true;
      return;
    }

    const items = draft.items
      .map(it=>({ id:String(it.id||"").trim(), name:it.name, price:Number(it.price||0), qty:Number(it.qty||0) }))
      .filter(it=>it.id && it.qty>0);

    if(items.length===0){
      setStatus("カートが空です。");
      btnCard.disabled = true; btnCod.disabled = true;
      return;
    }

    renderItems(items);

    const sub = items.reduce((s,it)=> s + it.price*it.qty, 0);
    sumSubtotalEl.textContent = yen(sub);
    sumCodEl.textContent = yen(COD_FEE);

    // 送料・合計はサーバ計算（住所あり前提）
    sumShippingEl.textContent = "—";
    sumTotalCardEl.textContent = "—";
    sumTotalCodEl.textContent = "—";

    btnAddress.addEventListener("click", openAddress);
    btnBack.addEventListener("click", ()=> history.back());

    btnCard.addEventListener("click", async ()=>{
      try{
        btnCard.disabled = true; btnCod.disabled = true;
        setStatus("Stripe決済画面へ移動します…（送料計算中）");

        const r = await callCheckout(items);

        sumShippingEl.textContent = yen(r.shippingFee);
        sumTotalCardEl.textContent = yen(r.subtotal + r.shippingFee);
        sumTotalCodEl.textContent = yen(r.subtotal + r.shippingFee + COD_FEE);

        setStatus("Stripeへ移動します…");
        location.href = r.checkoutUrl;
      }catch(e){
        console.error(e);
        const msg = (e && e.detail && e.detail.error === "NO_ADDRESS")
          ? "住所が未登録です。先に住所登録（LIFF）をしてください。"
          : "決済開始に失敗しました：\n" + (e?.message || String(e));
        setStatus(msg);
        btnCard.disabled = false; btnCod.disabled = false;
      }
    });

    btnCod.addEventListener("click", async ()=>{
      try{
        btnCard.disabled = true; btnCod.disabled = true;
        setStatus("代引き注文を作成しています…（送料計算中）");

        const r = await callCod(items);

        // 表示更新
        sumShippingEl.textContent = yen(r.shippingFee);
        sumTotalCardEl.textContent = yen(r.subtotal + r.shippingFee);
        sumTotalCodEl.textContent = yen(r.totalCod);

        // 完了画面へ
        location.href = "/public/cod-complete.html?orderId=" + encodeURIComponent(r.orderId);
      }catch(e){
        console.error(e);
        const msg = (e && e.detail && e.detail.error === "NO_ADDRESS")
          ? "住所が未登録です。先に住所登録（LIFF）をしてください。"
          : "代引き注文に失敗しました：\n" + (e?.message || String(e));
        setStatus(msg);
        btnCard.disabled = false; btnCod.disabled = false;
      }
    });
  }

  main();
})();
