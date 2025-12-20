// confirm.js — オンライン注文 共通確認画面（クレジット or 代引き）
// ★ 送料は必ず /api/shipping の結果のみを使用（計算しない）

(function () {
  "use strict";

  const COD_FEE = 330; // 代引き手数料（表示専用）

  // ===== DOM =====
  const orderListEl   = document.getElementById("orderList");
  const sumItemsEl    = document.getElementById("sumItems");
  const sumShippingEl = document.getElementById("sumShipping");
  const sumTotalEl    = document.getElementById("sumTotal");
  const cardTotalEl   = document.getElementById("cardTotalText");
  const statusEl      = document.getElementById("statusMsg");

  const cardBtn = document.getElementById("cardBtn");
  const codBtn  = document.getElementById("codBtn");
  const backBtn = document.getElementById("backBtn");

  // ===== util =====
  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  function yen(n) {
    return Number(n || 0).toLocaleString("ja-JP") + "円";
  }

  function renderOrderList(items) {
    if (!orderListEl) return;
    if (!items || !items.length) {
      orderListEl.innerHTML = '<p class="order-row">カートに商品がありません。</p>';
      return;
    }
    orderListEl.innerHTML = items.map(it => {
      const name = it.name || it.id || "商品";
      const qty  = Number(it.qty || 0);
      const price = Number(it.price || 0);
      return (
        `<div class="order-row">` +
        `${name} × ${qty}個 = ${yen(price * qty)}` +
        `</div>`
      );
    }).join("");
  }

  // ===== storage =====
  function loadOrderDraft() {
    try {
      const raw = sessionStorage.getItem("orderDraft");
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.items)) return null;
      return d;
    } catch (e) {
      console.warn("orderDraft parse error:", e);
      return null;
    }
  }

  // ===== 送料API（唯一の正）=====
  async function fetchShipping(items, address) {
    const a = address || {};

    // 住所キーの揺れを完全吸収（confirm / confirm-cod で同一）
    const normalizedAddress = {
      postal:     a.postal || a.zip || "",
      prefecture: a.prefecture || a.pref || "",
      city:       a.city || "",
      address1:   a.address1 || a.addr1 || "",
      address2:   a.address2 || a.addr2 || "",
      // 互換用
      addr1:      a.address1 || a.addr1 || "",
    };

    const normalizedItems = (items || []).map(it => ({
      id:    String(it.id || ""),
      name:  String(it.name || ""),
      price: Number(it.price || 0),
      qty:   Number(it.qty || 0),
    }));

    const res = await fetch("/api/shipping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: normalizedItems,
        address: normalizedAddress,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data?.error || "shipping_api_failed");
    }

    return {
      itemsTotal: Number(data.itemsTotal || 0),
      shipping:   Number(data.shipping || 0),
      region:     data.region || "",
      size:       data.size || "",
      finalTotal: Number(data.finalTotal || 0),
    };
  }

  // ===== init =====
  async function init() {
    setStatus("注文情報を読み込んでいます…");

    const draft = loadOrderDraft();
    if (!draft) {
      setStatus("注文情報が見つかりません。最初からやり直してください。");
      if (cardBtn) cardBtn.disabled = true;
      if (codBtn)  codBtn.disabled  = true;
      return;
    }

    const items   = draft.items || [];
    const address = draft.address || {};

    renderOrderList(items);

    let ship;
    try {
      ship = await fetchShipping(items, address);
    } catch (e) {
      console.error("shipping error:", e);
      const fallbackTotal = items.reduce(
        (s, it) => s + Number(it.price || 0) * Number(it.qty || 0),
        0
      );
      ship = { itemsTotal: fallbackTotal, shipping: 0, region: "", size: "", finalTotal: fallbackTotal };
    }

    const itemsTotal = ship.itemsTotal;
    const shipping   = ship.shipping;

    // ★ 合計はここでだけ計算（送料はAPIの値）
    const cardTotal = itemsTotal + shipping;
    const codTotal  = cardTotal + COD_FEE;

    // ===== 表示 =====
    if (sumItemsEl)    sumItemsEl.textContent    = yen(itemsTotal);
    if (sumShippingEl) sumShippingEl.textContent = yen(shipping);
    if (sumTotalEl)    sumTotalEl.textContent    = yen(codTotal);
    if (cardTotalEl)   cardTotalEl.textContent   = yen(cardTotal);

    // ===== 次画面用に保存（confirm-card / confirm-cod 共通）=====
    const summary = {
      items,
      address,
      lineUserId:   draft.lineUserId   || "",
      lineUserName: draft.lineUserName || "",
      itemsTotal,
      shipping,
      region: ship.region,
      size:   ship.size,
      codFee: COD_FEE,
      cardTotal,
      codTotal,
    };
    sessionStorage.setItem("orderSummary", JSON.stringify(summary));

    setStatus("お支払い方法を選択してください。");
  }

  // ===== events =====
  document.addEventListener("DOMContentLoaded", () => {
    init();

    if (cardBtn) {
      cardBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        window.location.href = "./confirm-card.html" + (window.location.search || "");
      });
    }

    if (codBtn) {
      codBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        window.location.href = "./confirm-cod.html" + (window.location.search || "");
      });
    }

    if (backBtn) {
      backBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        window.location.href = "./products.html";
      });
    }
  });
})();
