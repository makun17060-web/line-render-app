// public/confirm.js
// confirm.html：サーバー送料を取得して「商品合計 / 送料 / 合計」を別表示

(function () {
  const STORAGE_KEY = "isoya_order_v1";

  const itemsEl   = document.getElementById("itemsArea");
  const addrEl    = document.getElementById("addressArea");
  const itemsTotEl= document.getElementById("itemsTotalPrice");
  const shipEl    = document.getElementById("shippingPrice");
  const finalEl   = document.getElementById("finalTotalPrice");
  const backBtn   = document.getElementById("backToAddressBtn");
  const payBtn    = document.getElementById("toPayBtn");

  if (!itemsEl || !addrEl || !itemsTotEl || !shipEl || !finalEl || !backBtn || !payBtn) {
    console.warn("confirm.html の要素が見つかりません。confirm.html を丸ごと版に差し替えてください。");
    return;
  }

  function loadOrder() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch { return {}; }
  }

  function yen(n) {
    const num = Number(n || 0);
    return num.toLocaleString("ja-JP") + "円";
  }

  function calcItemsTotal(items = []) {
    return items.reduce(
      (sum, it) => sum + Number(it.price || 0) * Number(it.qty || 0),
      0
    );
  }

  async function fetchShipping(items, address) {
    const res = await fetch("/api/shipping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ items, address }),
    });
    return res.json();
  }

  const order = loadOrder();
  const items = Array.isArray(order.items) ? order.items : [];
  const address = order.address || {};

  // 1) 商品一覧表示
  if (!items.length) {
    itemsEl.innerHTML = "<div class='empty'>商品が選択されていません。</div>";
    payBtn.disabled = true;
  } else {
    itemsEl.innerHTML = items.map(it => `
      <div class="row">
        <div class="name">${it.name || ""}</div>
        <div class="qty">× ${it.qty || 0}</div>
        <div class="price">${yen((it.price||0)*(it.qty||0))}</div>
      </div>
    `).join("");
  }

  // 2) 住所表示
  const addrText = [
    `氏名：${address.lastName || ""} ${address.firstName || ""}`.trim(),
    address.zip ? `〒${address.zip}` : "",
    address.addr1 || "",
    address.addr2 || "",
    address.tel ? `TEL：${address.tel}` : ""
  ].filter(Boolean).join("<br>");

  addrEl.innerHTML = addrText || "<div class='empty'>住所が入力されていません。</div>";

  // 3) まず商品合計だけ出す
  const itemsTotal = calcItemsTotal(items);
  itemsTotEl.textContent = yen(itemsTotal);
  shipEl.textContent = "計算中…";
  finalEl.textContent = "計算中…";

  let shipping = 0;
  let finalTotal = itemsTotal;

  (async () => {
    try {
      const data = await fetchShipping(items, address);
      if (!data || !data.ok) throw new Error(data?.error || "shipping api error");

      shipping = Number(data.shipping || 0);
      finalTotal = Number(data.finalTotal || (itemsTotal + shipping));

      // ★個別表示
      itemsTotEl.textContent = yen(itemsTotal);
      shipEl.textContent = yen(shipping);
      finalEl.textContent = yen(finalTotal);

      payBtn.disabled = finalTotal <= 0;

      // 次画面で使うため保存
      const next = loadOrder();
      next.shipping = shipping;
      next.finalTotal = finalTotal;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));

    } catch (e) {
      console.error("送料取得失敗:", e);
      shipEl.textContent = "取得失敗（0円）";
      finalEl.textContent = yen(itemsTotal);
      payBtn.disabled = itemsTotal <= 0;
    }
  })();

  backBtn.addEventListener("click", () => {
    location.href = `${location.origin}/public/address.html?v=${Date.now()}`;
  });

  payBtn.addEventListener("click", () => {
    if (!items.length || finalTotal <= 0) return;
    location.href = `${location.origin}/public/pay.html?v=${Date.now()}`;
  });
})();
