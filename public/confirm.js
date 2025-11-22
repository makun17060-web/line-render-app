// /public/confirm.js
// ③ 最終確認（反映されない対策版）
// - 注文：session/local の複数キーを総当たりで拾う
// - 住所：storage に無ければ /api/liff/address/me を叩いて拾う（server.js 側対応も下に記載）
// - 送料計算、個別表示、④へ保存して遷移

(async function () {
  const $ = (id) => document.getElementById(id);

  const itemsArea       = $("itemsArea");
  const addressArea     = $("addressArea");
  const elItemsTotal    = $("itemsTotalPrice");
  const elShipping      = $("shippingPrice");
  const elFinalTotal    = $("finalTotalPrice");
  const backBtn         = $("backToAddressBtn");
  const toPayBtn        = $("toPayBtn");

  toPayBtn.disabled = true;

  // ---------- util ----------
  const yen = (n)=>`${Number(n||0).toLocaleString("ja-JP")}円`;
  const esc = (s)=>String(s||"")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");

  // ---------- 1) order 読み込み（総当たり強化） ----------
  function readOrderFromStorage() {
    const keys = [
      "currentOrder","confirmOrder","orderDraft","cart",
      "cartItems","productsSelected","checkoutDraft"
    ];
    for (const k of keys) {
      try {
        const v = sessionStorage.getItem(k) || localStorage.getItem(k);
        if (!v) continue;
        const obj = JSON.parse(v);
        if (obj && (obj.items || obj.cartItems || obj.products)) return obj;
        if (Array.isArray(obj)) return { items: obj }; // 配列だけ保存してる場合
      } catch {}
    }
    return null;
  }

  function normalizeItems(order) {
    const raw = order?.items || order?.cartItems || order?.products || [];
    if (!Array.isArray(raw)) return [];
    return raw.map(it=>({
      id: String(it.id||it.productId||"").trim(),
      name: String(it.name||it.productName||"").trim() || "商品",
      price: Number(it.price||it.unitPrice||0),
      qty: Number(it.qty||it.quantity||0),
      image: it.image||""
    })).filter(it=>it.id && it.qty>0);
  }

  const order = readOrderFromStorage();
  const items = normalizeItems(order);

  if (!items.length) {
    itemsArea.innerHTML =
      `<div class="empty">注文データが見つかりません。<br>①からやり直してください。</div>`;
    addressArea.innerHTML = `<div class="empty">住所データがありません。</div>`;
    elItemsTotal.textContent = yen(0);
    elShipping.textContent   = yen(0);
    elFinalTotal.textContent = yen(0);
    return;
  }

  // method
  const method = (order?.method || order?.receiveMethod || "delivery").trim();

  // ---------- 2) items 描画 ----------
  itemsArea.innerHTML = items.map(it=>{
    const line = it.price*it.qty;
    return `
      <div class="row">
        <div class="name">${esc(it.name)}</div>
        <div class="qty">×${it.qty}</div>
        <div class="price">${yen(line)}</div>
      </div>`;
  }).join("");

  const itemsTotal = items.reduce((s,it)=>s+it.price*it.qty,0);
  elItemsTotal.textContent = yen(itemsTotal);

  // ---------- 3) address 読み込み（storage → server fallback） ----------
  let address =
    order?.address ||
    order?.shippingAddress ||
    (()=>{ try{ return JSON.parse(sessionStorage.getItem("address")||"null"); }catch{return null;} })();

  // storage に無ければ server から拾う（userIdで検索するAPI）
  async function fetchAddressFromServer() {
    try {
      const r = await fetch("/api/liff/address/me", { cache:"no-store" });
      const d = await r.json();
      if (d && d.ok && d.address) return d.address;
    } catch {}
    return null;
  }

  if (!address && method !== "pickup") {
    const serverAddr = await fetchAddressFromServer();
    if (serverAddr) {
      address = serverAddr;
      sessionStorage.setItem("address", JSON.stringify(address));
    }
  }

  function renderAddress(addr) {
    if (method==="pickup") {
      addressArea.innerHTML = `<div>店頭受取（住所不要）</div>`;
      return;
    }
    if (!addr) {
      addressArea.innerHTML =
        `<div class="empty">住所が未登録です。②で住所入力してください。</div>`;
      return;
    }
    const lines = [
      addr.postal ? `〒${esc(addr.postal)}` : "",
      `${esc(addr.prefecture||"")}${esc(addr.city||"")}${esc(addr.address1||"")}`,
      addr.address2 ? esc(addr.address2) : "",
      addr.name ? `氏名：${esc(addr.name)}` : "",
      addr.phone ? `電話：${esc(addr.phone)}` : "",
    ].filter(Boolean);
    addressArea.innerHTML = lines.map(t=>`<div>${t}</div>`).join("");
  }
  renderAddress(address);

  // ---------- 4) shipping ----------
  let shipping=0, region="";

  async function calcShipping() {
    if (method==="pickup") { shipping=0; region="-"; return; }
    if (!address) { shipping=0; region=""; return; }
    try {
      const res = await fetch("/api/shipping", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ items, address })
      });
      const data = await res.json();
      if (data?.ok) {
        shipping = Number(data.shipping||0);
        region   = data.region||"";
      }
    } catch {}
  }

  await calcShipping();

  elShipping.textContent =
    method==="pickup" ? "0円（店頭受取）"
    : (region ? `${yen(shipping)}（${region}）` : yen(shipping));

  const finalTotal = itemsTotal + shipping;
  elFinalTotal.textContent = yen(finalTotal);

  // ---------- 5) ④へ倒す currentOrder を確実に作る ----------
  const confirmOrder = {
    items, method, address, region,
    shipping, itemsTotal, total: finalTotal
  };
  sessionStorage.setItem("confirmOrder", JSON.stringify(confirmOrder));
  sessionStorage.setItem("currentOrder", JSON.stringify(confirmOrder));

  toPayBtn.disabled = false;

  backBtn.addEventListener("click", ()=>history.back());
  toPayBtn.addEventListener("click", ()=>{
    sessionStorage.setItem("confirmOrder", JSON.stringify(confirmOrder));
    sessionStorage.setItem("currentOrder", JSON.stringify(confirmOrder));
    location.href = "/public/pay.html";
  });

})();
