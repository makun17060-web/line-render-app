// /public/confirm.js  — Stripe Checkout 版

(function () {
  "use strict";

  const orderListEl = document.getElementById("orderList");
  const totalEl     = document.getElementById("totalAmount");
  const confirmBtn  = document.getElementById("confirmBtn");
  const backBtn     = document.getElementById("backBtn");
  const statusMsgEl = document.getElementById("statusMsg");

  const STORAGE_KEY = "orderData";  // products.js 側と合わせること

  function loadOrderData() {
    try {
      const raw =
        sessionStorage.getItem(STORAGE_KEY) ||
        localStorage.getItem(STORAGE_KEY);

      if (!raw) return null;

      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items)) return null;

      return {
        items: data.items,
        totalAmount: Number(data.totalAmount || 0),
      };
    } catch (e) {
      console.error("注文データの読込に失敗:", e);
      return null;
    }
  }

  let order = loadOrderData();

  function renderOrder() {
    if (!order || !order.items.length) {
      if (orderListEl) {
        orderListEl.innerHTML =
          "<p>注文内容が見つかりません。商品一覧に戻ってやり直してください。</p>";
      }
      if (confirmBtn) confirmBtn.disabled = true;
      return;
    }

    if (orderListEl) {
      orderListEl.innerHTML = "";
      order.items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "order-row";
        row.textContent =
          `${item.name || "商品"} × ${item.quantity}個 （${item.unitPrice || item.price}円／個）`;
        orderListEl.appendChild(row);
      });
    }

    if (totalEl) {
      totalEl.textContent = `${order.totalAmount}円（税込）`;
    }
  }

  function setStatus(msg) {
    if (!statusMsgEl) return;
    statusMsgEl.textContent = msg || "";
  }

  async function startStripeCheckout() {
    if (!order || !order.items.length) {
      alert("注文内容がありません。商品一覧からやり直してください。");
      return;
    }

    const payload = {
      items: order.items.map((it) => ({
        name: it.name || "商品",
        unitPrice: Number(it.unitPrice || it.price || 0),
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

  if (confirmBtn) {
    confirmBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      startStripeCheckout();
    });
  }

  if (backBtn) {
    backBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      history.back();
    });
  }

  renderOrder();
})();

