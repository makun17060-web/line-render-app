// /public/confirm-card.js
// Stripe Checkout + LINE 通知用
// - sessionStorage/localStorage から注文データを読み込む
// - /api/order/complete で LINE 通知・ログ
// - /api/pay-stripe で Stripe Checkout へ遷移

(function () {
  "use strict";

  const orderListEl = document.getElementById("orderList");
  const totalEl     = document.getElementById("totalAmount");
  const confirmBtn  = document.getElementById("confirmBtn");
  const backBtn     = document.getElementById("backBtn");
  const statusMsgEl = document.getElementById("statusMsg");

  const STORAGE_KEYS = [
    "orderData",
    "miniappOrder",
    "currentOrder",
    "liffOrder"
  ];

  function setStatus(msg) {
    if (!statusMsgEl) return;
    statusMsgEl.textContent = msg || "";
  }

  // ---- 注文データを sessionStorage / localStorage から読む ----
  function loadRawData() {
    for (const key of STORAGE_KEYS) {
      try {
        const raw =
          sessionStorage.getItem(key) ||
          localStorage.getItem(key);
        if (!raw) continue;

        const data = JSON.parse(raw);
        if (!data) continue;

        console.log("confirm-card.js: 読み込んだ注文データキー:", key, data);
        return { key, data };
      } catch (e) {
        console.warn("confirm-card.js: JSON parse 失敗", e);
      }
    }
    return null;
  }

  // ---- いろんな形のデータを正規化する ----
  function normalizeOrder(raw) {
    if (!raw || !raw.data) return null;
    const src = raw.data;

    let items = [];
    let itemsTotal = 0;

    // パターン1: { items: [...], itemsTotal, shipping, codFee, finalTotal }
    if (Array.isArray(src.items)) {
      items = src.items.slice();
      itemsTotal =
        Number(src.itemsTotal || src.totalAmount || src.total || 0) || 0;
    }

    // パターン2: { cart: [...], itemsTotal, ... }
    if (!items.length && Array.isArray(src.cart)) {
      items = src.cart.slice();
      itemsTotal =
        Number(src.itemsTotal || src.totalAmount || src.total || 0) || 0;
    }

    if (!items.length) return null;

    const normItems = [];
    let calcItemsTotal = 0;

    for (const it of items) {
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

      const price =
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

      if (qty <= 0 || price < 0) continue;

      normItems.push({ id, name, price, qty });
      calcItemsTotal += price * qty;
    }

    if (!normItems.length) return null;

    if (!itemsTotal || itemsTotal <= 0) {
      itemsTotal = calcItemsTotal;
    }

    const shipping = Number(src.shipping || 0) || 0;
    const codFee   = Number(src.codFee   || 0) || 0;
    let finalTotal = Number(src.finalTotal || 0) || 0;
    if (!finalTotal || finalTotal <= 0) {
      finalTotal = itemsTotal + shipping + codFee;
    }

    return {
      items: normItems,
      itemsTotal,
      shipping,
      codFee,
      finalTotal,
      lineUserId:   String(src.lineUserId   || "").trim(),
      lineUserName: String(src.lineUserName || "").trim(),
      address: src.address || null,
    };
  }

  let order = null;

  function showNoOrder() {
    if (orderListEl) {
      orderListEl.innerHTML =
        "<p>商品内容が確認できません。<br>商品一覧に戻って、もう一度やり直してください。</p>";
    }
    if (confirmBtn) confirmBtn.disabled = true;
    if (totalEl) totalEl.textContent = "0";
  }

  function renderOrder() {
    if (!order || !order.items || !order.items.length) {
      showNoOrder();
      return;
    }

    if (orderListEl) {
      orderListEl.innerHTML = "";
      order.items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "order-row";
        const unit = Number(item.price || 0);
        const qty  = Number(item.qty   || 0);
        const lineTotal = unit * qty;

        row.textContent =
          `${item.name || "商品"} × ${qty}個 （${unit}円／個 = ${lineTotal}円）`;
        orderListEl.appendChild(row);
      });
    }

    if (totalEl) {
      totalEl.textContent = String(order.finalTotal || order.itemsTotal || 0);
    }
  }

  function initOrder() {
    const raw = loadRawData();
    if (!raw) {
      showNoOrder();
      return;
    }
    const normalized = normalizeOrder(raw);
    if (!normalized || !normalized.items.length) {
      showNoOrder();
      return;
    }
    order = normalized;
    console.log("confirm-card.js: 正規化後の注文データ:", order);
    renderOrder();
  }

  // ---- /api/order/complete に通知を送る（LINE通知 & ログ）----
  async function notifyOrderComplete() {
    if (!order || !order.items || !order.items.length) return;

    const payload = {
      items: order.items.map((it) => ({
        name: it.name || "商品",
        price: Number(it.price || 0),
        qty: Number(it.qty || 0),
      })),
      itemsTotal: Number(order.itemsTotal || 0),
      shipping:   Number(order.shipping   || 0),
      codFee:     Number(order.codFee     || 0),
      finalTotal: Number(order.finalTotal || order.itemsTotal || 0),
      lineUserId:   order.lineUserId   || "",
      lineUserName: order.lineUserName || "",
      address:      order.address      || null,
    };

    try {
      const res = await fetch("/api/order/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      console.log("/api/order/complete res:", data);
    } catch (e) {
      console.error("/api/order/complete error:", e);
      // 通知に失敗しても決済は続行させる
    }
  }

  // ---- Stripe Checkout を開始 ----
  async function startStripeCheckout() {
    if (!order || !order.items || !order.items.length) {
      alert("注文内容がありません。商品一覧からやり直してください。");
      return;
    }

    const payload = {
      items: order.items.map((it) => ({
        id:   it.id,
        name: it.name || "商品",
        price: Number(it.price || 0),
        qty:   Number(it.qty   || 0),
      })),
      itemsTotal: Number(order.itemsTotal || 0),
      shipping:   Number(order.shipping   || 0),
      codFee:     Number(order.codFee     || 0),
      finalTotal: Number(order.finalTotal || order.itemsTotal || 0),
      lineUserId:   order.lineUserId   || "",
      lineUserName: order.lineUserName || "",
      address:      order.address      || null,
    };

    if (!payload.items.length || !payload.itemsTotal) {
      alert("注文データに不備があります。商品一覧からやり直してください。");
      return;
    }

    try {
      setStatus("決済を開始しています…");
      if (confirmBtn) confirmBtn.disabled = true;

      // ① 先に /api/order/complete を叩いて LINE 通知＆ログ
      await notifyOrderComplete();

      // ② Stripe Checkout Session を作成
      const res = await fetch("/api/pay-stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        console.error("決済APIエラー HTTP:", res.status);
        alert("決済の開始に失敗しました。時間をおいてもう一度お試しください。");
        setStatus("");
        if (confirmBtn) confirmBtn.disabled = false;
        return;
      }

      const data = await res.json();
      console.log("Stripe /api/pay-stripe レスポンス:", data);

      if (!data || !data.ok || !data.checkoutUrl) {
        alert("決済の開始に失敗しました。時間をおいてもう一度お試しください。");
        setStatus("");
        if (confirmBtn) confirmBtn.disabled = false;
        return;
      }

      // Stripe Checkout へ遷移
      location.href = data.checkoutUrl;
    } catch (e) {
      console.error("決済開始時の例外:", e);
      alert("通信エラーが発生しました。時間をおいてもう一度お試しください。");
      setStatus("");
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  // ---- イベントハンドラ ----
  if (confirmBtn) {
    confirmBtn.addEventListener("click", function (ev) {
      ev.preventDefault();
      startStripeCheckout();
    });
  }

  if (backBtn) {
    backBtn.addEventListener("click", function (ev) {
      ev.preventDefault();
      history.back();
    });
  }

  // 初期化
  initOrder();
})();
