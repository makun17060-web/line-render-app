// public/confirm.js
// confirm.html 用：localStorageの注文/住所を表示し、pay.htmlへ進む

(function () {
  const STORAGE_KEY = "isoya_order_v1";

  const itemsEl = document.getElementById("itemsArea");
  const totalEl = document.getElementById("totalPrice");
  const addrEl  = document.getElementById("addressArea");
  const backBtn = document.getElementById("backToAddressBtn");
  const payBtn  = document.getElementById("toPayBtn");

  if (!itemsEl || !totalEl || !addrEl || !backBtn || !payBtn) {
    console.warn("confirm.html の要素が見つかりません。confirm.html を丸ごと版に差し替えてください。");
    return;
  }

  function loadOrder() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function yen(n) {
    const num = Number(n || 0);
    return num.toLocaleString("ja-JP") + "円";
  }

  function calcTotal(items = []) {
    return items.reduce(
      (sum, it) => sum + Number(it.price || 0) * Number(it.qty || 0),
      0
    );
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
        <div class="price">${yen((it.price || 0) * (it.qty || 0))}</div>
      </div>
    `).join("");
  }

  // 2) 合計表示
  const total = calcTotal(items);
  totalEl.textContent = yen(total);

  // 3) 住所表示
  const addrText = [
    `氏名：${address.lastName || ""} ${address.firstName || ""}`.trim(),
    address.zip ? `〒${address.zip}` : "",
    address.addr1 || "",
    address.addr2 || "",
    address.tel ? `TEL：${address.tel}` : ""
  ].filter(Boolean).join("<br>");

  addrEl.innerHTML = addrText || "<div class='empty'>住所が入力されていません。</div>";

  // 4) 戻る（住所入力へ）
  backBtn.addEventListener("click", () => {
    location.href = `${location.origin}/public/address.html?v=${Date.now()}`;
  });

  // 5) 支払いへ
  payBtn.addEventListener("click", () => {
    if (!items.length || total <= 0) return;
    location.href = `${location.origin}/public/pay.html?v=${Date.now()}`;
  });
})();
