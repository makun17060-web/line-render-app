// /public/confirm.js
// ③ 最終確認画面（丸ごと・保存付き）
// - ①の商品データを storage から取得
// - ②の住所を storage から取得
// - /api/shipping で送料計算
// - 商品合計 / 送料 / 合計 を個別表示
// - 「④ クレジット支払いへ進む」で currentOrder を保存して pay.html へ遷移

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

  // -----------------------------
  // 共通ユーティリティ
  // -----------------------------
  function yen(n) {
    return `${Number(n || 0).toLocaleString("ja-JP")}円`;
  }
  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // -----------------------------
  // 1) 注文情報を storage から取得
  // -----------------------------
  function readOrderFromStorage() {
    // ②までの画面で入りそうなキーを全部見に行く
    const keys = ["currentOrder", "confirmOrder", "cart", "orderDraft"];
    for (const k of keys) {
      try {
        const v = sessionStorage.getItem(k) || localStorage.getItem(k);
        if (!v) continue;
        const obj = JSON.parse(v);
        if (obj && (obj.items || obj.cartItems || obj.products)) return obj;
      } catch {}
    }
    return null;
  }

  function normalizeItems(order) {
    const raw =
      order?.items ||
      order?.cartItems ||
      order?.products ||
      [];
    if (!Array.isArray(raw)) return [];

    return raw
      .map(it => ({
        id: String(it.id || it.productId || "").trim(),
        name: String(it.name || it.productName || "").trim() || "商品",
        price: Number(it.price || it.unitPrice || 0),
        qty: Number(it.qty || it.quantity || 0),
        image: it.image || ""
      }))
      .filter(it => it.id && it.qty > 0);
  }

  const order = readOrderFromStorage();
  const items = normalizeItems(order);

  if (!items.length) {
    itemsArea.innerHTML =
      `<div class="empty">注文データが見つかりません。<br>①の商品選択からやり直してください。</div>`;
    addressArea.innerHTML =
      `<div class="empty">住所データがありません。</div>`;
    elItemsTotal.textContent = "0円";
    elShipping.textContent   = "0円";
    elFinalTotal.textContent = "0円";
    return;
  }

  // 受取方法（delivery/pickup）
  const method =
    (order?.method || order?.receiveMethod || "delivery").trim();

  // 住所
  const address =
    order?.address ||
    order?.shippingAddress ||
    JSON.parse(sessionStorage.getItem("address") || "null");

  // -----------------------------
  // 2) 商品表示
  // -----------------------------
  function renderItems(list) {
    itemsArea.innerHTML = list.map(it => {
      const lineTotal = it.price * it.qty;
      return `
        <div class="row">
          <div class="name">${escapeHtml(it.name)}</div>
          <div class="qty">×${it.qty}</div>
          <div class="price">${yen(lineTotal)}</div>
        </div>
      `;
    }).join("");
  }
  renderItems(items);

  const itemsTotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  elItemsTotal.textContent = yen(itemsTotal);

  // -----------------------------
  // 3) 住所表示
  // -----------------------------
  function renderAddress(addr) {
    if (!addr) {
      addressArea.innerHTML =
        `<div class="empty">住所が未登録です。②で住所入力してください。</div>`;
      return;
    }

    const lines = [
      addr.postal ? `〒${escapeHtml(addr.postal)}` : "",
      `${escapeHtml(addr.prefecture||"")}${escapeHtml(addr.city||"")}${escapeHtml(addr.address1||"")}`,
      addr.address2 ? escapeHtml(addr.address2) : "",
      addr.name ? `氏名：${escapeHtml(addr.name)}` : "",
      addr.phone ? `電話：${escapeHtml(addr.phone)}` : "",
    ].filter(Boolean);

    addressArea.innerHTML = lines.map(t => `<div>${t}</div>`).join("");
  }
  renderAddress(address);

  // -----------------------------
  // 4) 送料計算
  // -----------------------------
  let shipping = 0;
  let region = "";

  async function calcShipping() {
    // 店頭受取なら0
    if (method === "pickup") {
      shipping = 0;
      region = "-";
      return;
    }
    // 住所が無いと判定できない
    if (!address) {
      shipping = 0;
      region = "";
      return;
    }

    try {
      const res = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, address })
      });
      const data = await res.json();
      if (data && data.ok) {
        shipping = Number(data.shipping || 0);
        region = data.region || "";
      } else {
        shipping = 0;
        region = "";
      }
    } catch {
      shipping = 0;
      region = "";
    }
  }

  await calcShipping();

  elShipping.textContent =
    method === "pickup"
      ? "0円（店頭受取）"
      : (region ? `${yen(shipping)}（${region}）` : yen(shipping));

  const finalTotal = itemsTotal + shipping;
  elFinalTotal.textContent = yen(finalTotal);

  // -----------------------------
  // 5) ④へ行く前に保存する confirmOrder を作る
  // -----------------------------
  const confirmOrder = {
    items,
    method,          // delivery / pickup
    address,         // null or address object
    region,
    shipping,
    itemsTotal,
    total: finalTotal
  };

  // ③画面に来た時点で一度保存しておく（保険）
  sessionStorage.setItem("confirmOrder", JSON.stringify(confirmOrder));
  sessionStorage.setItem("currentOrder", JSON.stringify(confirmOrder));

  // ④ボタンを押せるように
  toPayBtn.disabled = false;

  // -----------------------------
  // 6) ボタン
  // -----------------------------

  // ②へ戻る
  backBtn.addEventListener("click", () => history.back());

  // ④へ進む（重要：必ず保存してから移動）
  toPayBtn.addEventListener("click", () => {
    sessionStorage.setItem("confirmOrder", JSON.stringify(confirmOrder));
    sessionStorage.setItem("currentOrder", JSON.stringify(confirmOrder));
    location.href = "/public/pay.html";
  });

})();
