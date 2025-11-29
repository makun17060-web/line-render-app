// /public/confirm-card.js — クレジットカード専用（Stripe）
// ・いろいろな形式の注文データに対応して商品金額を表示
// ・送料が無ければ /api/shipping で自動計算
// ・/api/pay-stripe に投げて Checkout へ遷移

(function () {
  "use strict";

  const orderListEl = document.getElementById("orderList");
  const totalEl     = document.getElementById("cardTotal");
  const buttonEl    = document.getElementById("confirmCard");

  function yen(n) {
    return `${Number(n || 0).toLocaleString("ja-JP")}円`;
  }

  function setStatus(msg) {
    // confirm-card.html には status 表示がないので、必要なら後で追加
    console.log("[confirm-card] status:", msg);
  }

  // ---- ストレージから注文データを読む（いろんなキー対応） ----
  function loadRawData() {
    const keys = [
      "orderData",
      "miniappOrder",
      "currentOrder",
      "liffOrder",
      "codOrder",        // 念のため
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
        console.warn("confirm-card: JSON parse失敗", e);
      }
    }
    return null;
  }

  // ---- いろんな形のデータを正規化する ----
  function normalizeOrder(raw) {
    if (!raw) return null;

    // 典型パターン: { data: {...} } / { order: {...} }
    const src = raw.data || raw.order || raw;

    // items or cart などを拾う
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

    const shipping = Number(src.shipping || 0) || 0;

    const address      = src.address || null;
    const lineUserId   = src.lineUserId   || src.userId   || "";
    const lineUserName = src.lineUserName || src.userName || "";
    const method       = src.method       || "delivery";

    return {
      items,
      itemsTotal,
      shipping,
      address,
      lineUserId,
      lineUserName,
      method,
    };
  }

  // ---- shipping が無ければ /api/shipping で計算 ----
  async function applyShippingIfNeeded(order) {
    if (!order) return order;
    // 店頭受取なら送料 0 のままでOK
    if (order.method === "pickup") return order;

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
      console.log("api/shipping result:", data);

      if (!data || !data.ok) return order;

      const itemsTotal = Number(data.itemsTotal || order.itemsTotal || 0);
      const shipping   = Number(data.shipping   || 0);

      return {
        ...order,
        itemsTotal,
        shipping,
      };
    } catch (e) {
      console.error("applyShippingIfNeeded error:", e);
      return order;
    }
  }

  let order = null;

  async function init() {
    const raw = loadRawData();
    if (!raw) {
      if (orderListEl) {
        orderListEl.innerHTML =
          "<p>注文情報が見つかりません。商品一覧からやり直してください。</p>";
      }
      if (buttonEl) buttonEl.disabled = true;
      return;
    }

    let normalized = normalizeOrder(raw);
    if (!normalized || !normalized.items.length) {
      if (orderListEl) {
        orderListEl.innerHTML =
          "<p>注文情報が見つかりません。商品一覧からやり直してください。</p>";
      }
      if (buttonEl) buttonEl.disabled = true;
      return;
    }

    // 送料が無ければサーバーで計算
    normalized = await applyShippingIfNeeded(normalized);
    order = normalized;

    render();
  }

  function render() {
    if (!order || !order.items || !order.items.length) return;

    const itemsTotal = Number(order.itemsTotal || 0);
    const shipping   = Number(order.shipping   || 0);
    const total      = itemsTotal + shipping;

    if (orderListEl) {
      orderListEl.innerHTML = "";
      order.items.forEach(it => {
        const row = document.createElement("div");
        row.textContent =
          `${it.name} × ${it.qty}個 = ${yen(it.price * it.qty)}`;
        orderListEl.appendChild(row);
      });
    }

    if (totalEl) {
      totalEl.textContent = yen(total);
    }
  }

  // ---- Stripe Checkout 開始 ----
  async function startStripeCheckout() {
    if (!order || !order.items || !order.items.length) {
      alert("注文内容がありません。商品一覧からやり直してください。");
      return;
    }

    // 最新送料を反映してから送信
    order = await applyShippingIfNeeded(order);
    render();

    const itemsTotal = Number(order.itemsTotal || 0);
    const shipping   = Number(order.shipping   || 0);
    const codFee     = 0;
    const finalTotal = itemsTotal + shipping + codFee;

    const payload = {
      lineUserId:   order.lineUserId   || "",
      lineUserName: order.lineUserName || "",
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
      address: order.address || null,
      payment: "card",
      method:  order.method || "delivery",
    };

    if (!payload.items.length || !payload.itemsTotal) {
      alert("注文データに不備があります。商品一覧からやり直してください。");
      return;
    }

    try {
      setStatus("クレジット決済を開始しています…");
      if (buttonEl) buttonEl.disabled = true;

      // 決済完了後の /api/order/complete 用に保存
      localStorage.setItem("lastStripeOrder", JSON.stringify(payload));

      const res = await fetch("/api/pay-stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        console.error("/api/pay-stripe HTTP error:", res.status);
        alert("決済の開始に失敗しました。時間をおいてもう一度お試しください。");
        if (buttonEl) buttonEl.disabled = false;
        setStatus("");
        return;
      }

      const data = await res.json();
      console.log("Stripe /api/pay-stripe response:", data);

      if (!data || !data.ok || !data.checkoutUrl) {
        alert("決済の開始に失敗しました。時間をおいてもう一度お試しください。");
        if (buttonEl) buttonEl.disabled = false;
        setStatus("");
        return;
      }

      location.href = data.checkoutUrl;
    } catch (e) {
      console.error("startStripeCheckout error:", e);
      alert("通信エラーが発生しました。時間をおいてもう一度お試しください。");
      if (buttonEl) buttonEl.disabled = false;
      setStatus("");
    }
  }

  if (buttonEl) {
    buttonEl.addEventListener("click", function (ev) {
      ev.preventDefault();
      startStripeCheckout();
    });
  }

  (async () => {
    await init();
  })();
})();
