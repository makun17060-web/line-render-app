// /public/confirm.js — Stripe Checkout 版（複数形式の注文データに対応）

(function () {
  "use strict";

  const orderListEl = document.getElementById("orderList");
  const totalEl     = document.getElementById("totalAmount");
  const confirmBtn  = document.getElementById("confirmBtn");
  const backBtn     = document.getElementById("backBtn");
  const statusMsgEl = document.getElementById("statusMsg");

  const STORAGE_KEYS = [
    "orderData",      // 私が前に提案したキー
    "miniappOrder",   // 以前のミニアプリ用によく使うキー名
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

        console.log("confirm.js: 読み込んだ注文データキー:", key, data);
        return { key, data };
      } catch (e) {
        console.warn("confirm.js: JSON parse 失敗", e);
      }
    }
    return null;
  }

  // ---- いろんな形のデータを正規化する ----
  function normalizeOrder(raw) {
    if (!raw || !raw.data) return null;
    const src = raw.data;

    let items = [];
    let totalAmount = 0;

    // パターン1: { items: [...], totalAmount }
    if (Array.isArray(src.items)) {
      items = src.items.slice();
      totalAmount =
        Number(src.totalAmount || src.itemsTotal || src.total || 0) || 0;
    }

    // パターン2: { cart: [...], itemsTotal }
    if (!items.length && Array.isArray(src.cart)) {
      items = src.cart.slice();
      totalAmount =
        Number(src.itemsTotal || src.totalAmount || src.total || 0) || 0;
    }

    if (!items.length) return null;

    // アイテムを { id, name, unitPrice, quantity } に揃える
    const normItems = [];
    let calcTotal = 0;

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

      const unitPrice =
        Number(
          it.unitPrice ||
          it.price ||
          it.unit_price ||
          it.unit ||
          0
        ) || 0;

      const quantity =
        Number(
          it.quantity ||
          it.qty ||
          it.count ||
          it.num ||
          0
        ) || 0;

      if (quantity <= 0 || unitPrice < 0) continue;

      normItems.push({ id, name, unitPrice, quantity });
      calcTotal += unitPrice * quantity;
    }

    if (!normItems.length) return null;

    if (!totalAmount || totalAmount <= 0) {
      totalAmount = calcTotal;
    }

    return {
      items: normItems,
      totalAmount
    };
  }

  let order = null;

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
    renderOrder();
  }

  function showNoOrder() {
    if (orderListEl) {
      orderListEl.innerHTML =
        "<p>商品内容が確認できません。<br>商品一覧に戻って、もう一度やり直してください。</p>";
    }
    if (confirmBtn) confirmBtn.disabled = true;
    if (totalEl) totalEl.textContent = "0";
  }

  // ---- 画面に注文内容を表示 ----
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
        const unit = Number(item.unitPrice || 0);
        const qty  = Number(item.quantity || 0);
        const lineTotal = unit * qty;

        row.textContent =
          `${item.name || "商品"} × ${qty}個 （${unit}円／個 = ${lineTotal}円）`;
        orderListEl.appendChild(row);
      });
    }

    if (totalEl) {
      totalEl.textContent = String(order.totalAmount || 0);
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
        id: it.id,
        name: it.name || "商品",
        unitPrice: Number(it.unitPrice || 0),
        quantity: Number(it.quantity || 1),
      })),
      totalAmount: Number(order.totalAmount || 0),
    };

    if (!payload.items.length || !payload.totalAmount) {
      alert("注文データに不備があります。商品一覧からやり直してください。");
      return;
    }

    try {
      setStatus("決済を開始しています…");
      if (confirmBtn) confirmBtn.disabled = true;

      const res = await fetch("/api/pay", {
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
      console.log("Stripe /api/pay レスポンス:", data);

      if (!data || !data.ok || !data.url) {
        alert("決済の開始に失敗しました。時間をおいてもう一度お試しください。");
        setStatus("");
        if (confirmBtn) confirmBtn.disabled = false;
        return;
      }

      // Stripe Checkout へ遷移
      location.href = data.url;
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
