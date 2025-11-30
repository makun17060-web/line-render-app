// /public/confirm-card.js
// クレジット決済用：商品合計 + 送料 を明細表示して Stripe 決済へ

(function () {
  "use strict";

  const orderListEl = document.getElementById("orderList");
  const sumItemsEl  = document.getElementById("sumItems");
  const sumShipEl   = document.getElementById("sumShipping");
  const sumTotalEl  = document.getElementById("sumTotal");
  const btnPay      = document.getElementById("confirmCard");
  const btnBack     = document.getElementById("backBtn");
  const statusMsgEl = document.getElementById("statusMsg");

  function yen(n) {
    return `${Number(n || 0).toLocaleString("ja-JP")}円`;
  }

  function setStatus(msg) {
    if (!statusMsgEl) return;
    statusMsgEl.textContent = msg || "";
  }

  // ---- ストレージから注文データを読む ----
  function loadRawData() {
    const keys = [
      "orderData",
      "miniappOrder",
      "currentOrder",
      "liffOrder",
      "cardOrder",
    ];
    for (const key of keys) {
      try {
        const raw =
          sessionStorage.getItem(key) ||
          localStorage.getItem(key);
        if (!raw) continue;
        const data = JSON.parse(raw);
        console.log("confirm-card: 読み込んだキー:", key, data);
        return data;
      } catch (e) {
        console.warn("confirm-card: JSON parse 失敗", e);
      }
    }
    return null;
  }

  // ---- いろんな形式の注文データを正規化 ----
  function normalizeOrder(raw) {
    if (!raw) return null;

    // { data: {...} } / { order: {...} } / それ以外 のどれでも対応
    const src = raw.data || raw.order || raw;

    // items / cart に対応
    let itemsSrc =
      Array.isArray(src.items) ? src.items :
      Array.isArray(src.cart)  ? src.cart  :
      null;

    if (!itemsSrc || !itemsSrc.length) return null;

    const items = [];
    let calcItemsTotal = 0;

    for (const it of itemsSrc) {
      if (!it) continue;

      const id =
        it.id ||
        it.productId ||
        it.code ||
        "";

      const name =
        it.name ||
        it.productName ||
        "商品";

      const unitPrice =
        Number(
          it.price ||
          it.unitPrice ||
          it.unit_price ||
          it.unit ||
          0
        ) || 0;

      const qty =
        Number(
          it.qty ||
          it.quantity ||
          it.count ||
          it.num ||
          0
        ) || 0;

      if (!qty || unitPrice < 0) continue;

      items.push({ id, name, price: unitPrice, qty });
      calcItemsTotal += unitPrice * qty;
    }

    if (!items.length) return null;

    const itemsTotal =
      Number(src.itemsTotal || src.totalAmount || src.total || 0) || calcItemsTotal;

    // すでに shipping が入っていればそれを使う
    const shipping = Number(src.shipping || 0) || 0;

    const address      = src.address || null;
    const lineUserId   = src.lineUserId   || src.userId   || "";
    const lineUserName = src.lineUserName || src.userName || "";
    const method       = src.method       || "delivery";

    const finalTotal = itemsTotal + shipping; // クレジットなので代引き手数料は無し

    return {
      items,
      itemsTotal,
      shipping,
      finalTotal,
      address,
      lineUserId,
      lineUserName,
      method,
    };
  }

  // ---- 送料が 0 で住所があれば /api/shipping で自動計算 ----
  async function applyShippingIfNeeded(order) {
    if (!order) return order;
    if (order.method === "pickup") return order; // 店頭受取は送料 0 前提

    if ((order.shipping && order.shipping > 0) || !order.address) {
      return order;
    }

    try {
      const res = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: order.items.map(it => ({
            id: it.id,
            price: it.price,
            qty: it.qty,
          })),
          address: order.address,
        }),
      });
      if (!res.ok) {
        console.warn("api/shipping HTTP error:", res.status);
        return order;
      }
      const data = await res.json();
      console.log("api/shipping result (card):", data);

      if (!data || !data.ok) return order;

      const itemsTotal = Number(data.itemsTotal || order.itemsTotal || 0);
      const shipping   = Number(data.shipping   || 0);
      const finalTotal = itemsTotal + shipping;

      return {
        ...order,
        itemsTotal,
        shipping,
        finalTotal,
      };
    } catch (e) {
      console.error("applyShippingIfNeeded(card) error:", e);
      return order;
    }
  }

  let order = null;

  // ---- 画面に反映 ----
  function render() {
    if (!order || !order.items || !order.items.length) {
      if (orderListEl) {
        orderListEl.innerHTML =
          "<p>注文情報が見つかりません。商品一覧からやり直してください。</p>";
      }
      if (btnPay) btnPay.disabled = true;
      return;
    }

    const itemsTotal = Number(order.itemsTotal || 0);
    const shipping   = Number(order.shipping   || 0);
    const finalTotal = Number(order.finalTotal || (itemsTotal + shipping));

    if (orderListEl) {
      orderListEl.innerHTML = "";
      order.items.forEach(it => {
        const row = document.createElement("div");
        row.className = "row";
        row.textContent =
          `${it.name} × ${it.qty}個 = ${yen(it.price * it.qty)}`;
        orderListEl.appendChild(row);
      });
    }

    if (sumItemsEl) sumItemsEl.textContent  = yen(itemsTotal);
    if (sumShipEl)  sumShipEl.textContent   = yen(shipping);
    if (sumTotalEl) sumTotalEl.textContent  = yen(finalTotal);

    setStatus("内容をご確認のうえ「クレジットで支払う」を押してください。");
  }

  // ---- 初期化 ----
  async function init() {
    setStatus("注文情報を読み込んでいます…");

    const raw = loadRawData();
    if (!raw) {
      if (orderListEl) {
        orderListEl.innerHTML =
          "<p>注文情報が見つかりません。商品一覧からやり直してください。</p>";
      }
      if (btnPay) btnPay.disabled = true;
      setStatus("注文情報が見つかりません。");
      return;
    }

    let normalized = normalizeOrder(raw);
    if (!normalized || !normalized.items.length) {
      if (orderListEl) {
        orderListEl.innerHTML =
          "<p>注文情報が見つかりません。商品一覧からやり直してください。</p>";
      }
      if (btnPay) btnPay.disabled = true;
      setStatus("注文情報が見つかりません。");
      return;
    }

    // 送料が未計算ならサーバーに問い合わせ
    normalized = await applyShippingIfNeeded(normalized);
    order = normalized;

    render();
  }

  // ---- Stripe Checkout 開始 ----
  async function startStripeCheckout() {
    if (!order || !order.items || !order.items.length) {
      alert("注文内容がありません。商品一覧からやり直してください。");
      return;
    }

    // 念のため最新の送料に更新
    order = await applyShippingIfNeeded(order);
    render();

    const itemsTotal = Number(order.itemsTotal || 0);
    const shipping   = Number(order.shipping   || 0);
    const codFee     = 0;
    const finalTotal = Number(order.finalTotal || (itemsTotal + shipping));

    const payload = {
      lineUserId:   order.lineUserId   || "",
      lineUserName: order.lineUserName || "",
      address:      order.address      || null,
      method:       order.method       || "delivery",
      items: order.items.map(it => ({
        id:   it.id,
        name: it.name || "商品",
        price: Number(it.price || 0),
        qty:   Number(it.qty   || 0),
      })),
      itemsTotal,
      shipping,
      codFee,
      finalTotal,
    };

    try {
      setStatus("クレジット決済を開始しています…");
      if (btnPay) btnPay.disabled = true;

      const res = await fetch("/api/pay-stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        console.error("pay-stripe HTTP error:", res.status);
        alert("決済の開始に失敗しました。時間をおいてもう一度お試しください。");
        setStatus("決済の開始に失敗しました。");
        if (btnPay) btnPay.disabled = false;
        return;
      }

      const data = await res.json();
      console.log("pay-stripe response:", data);

      if (!data || !data.ok || !data.checkoutUrl) {
        alert("決済の開始に失敗しました。時間をおいてもう一度お試しください。");
        setStatus("決済の開始に失敗しました。");
        if (btnPay) btnPay.disabled = false;
        return;
      }

      // Stripe Checkout へ遷移
      location.href = data.checkoutUrl;
    } catch (e) {
      console.error("startStripeCheckout error:", e);
      alert("通信エラーが発生しました。時間をおいてもう一度お試しください。");
      setStatus("通信エラーが発生しました。");
      if (btnPay) btnPay.disabled = false;
    }
  }

  if (btnPay) {
    btnPay.addEventListener("click", function (ev) {
      ev.preventDefault();
      startStripeCheckout();
    });
  }

  if (btnBack) {
    btnBack.addEventListener("click", function (ev) {
      ev.preventDefault();
      history.back();
    });
  }

  (async () => {
    await init();
  })();
})();
