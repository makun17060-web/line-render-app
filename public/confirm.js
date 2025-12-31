(function () {
  "use strict";

  const orderListEl   = document.getElementById("orderList");
  const sumItemsEl    = document.getElementById("sumItems");
  const sumShippingEl = document.getElementById("sumShipping");
  const sumCodEl      = document.getElementById("sumCod");
  const sumTotalCodEl = document.getElementById("sumTotalCod");
  const statusEl      = document.getElementById("statusMsg");

  const cardBtn = document.getElementById("cardBtn");
  const codBtn  = document.getElementById("codBtn");
  const backBtn = document.getElementById("backBtn");

  const COD_FEE = 330;

  console.log("[ISOYA][confirm.js] LOADED", location.href, new Date().toISOString());
  window.addEventListener("error", (e) => console.error("[ISOYA][confirm.js] WINDOW ERROR:", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => console.error("[ISOYA][confirm.js] UNHANDLED:", e.reason));

  function setStatus(msg = "") { if (statusEl) statusEl.textContent = msg; }
  function yen(n) { return (Number(n) || 0).toLocaleString("ja-JP") + "円"; }
  function safeJsonParse(s){ try { return JSON.parse(s); } catch { return null; } }
  function safeNumber(n, def = 0){ const x = Number(n); return Number.isFinite(x) ? x : def; }

  function readOrderFromStorage() {
    // ✅ いろんな版が混ざっても拾えるように幅広く
    const keys = [
      "orderDraft",
      "currentOrder",
      "order",
      "confirm_normalized_order",
      "lastOrder"
    ];
    for (const store of [sessionStorage, localStorage]) {
      for (const k of keys) {
        const raw = store.getItem(k);
        if (!raw) continue;
        const obj = safeJsonParse(raw);
        if (obj && typeof obj === "object") return obj;
      }
    }
    return null;
  }

  function saveOrder(order) {
    const s = JSON.stringify(order);
    sessionStorage.setItem("orderDraft", s);
    sessionStorage.setItem("order", s);
    sessionStorage.setItem("currentOrder", s);
    sessionStorage.setItem("confirm_normalized_order", s);
    localStorage.setItem("order", s);
  }

  function normalizeItems(order) {
    const items = (Array.isArray(order?.items) ? order.items : [])
      .map((it) => ({
        id: String(it.id || "").trim(),
        name: String(it.name || it.id || "商品").trim(),
        price: safeNumber(it.price, 0),
        qty: safeNumber(it.qty, 0),
      }))
      .filter((it) => it.id && it.qty > 0);
    return items;
  }

  function renderItems(items) {
    if (!orderListEl) return;
    orderListEl.innerHTML = "";
    items.forEach((it) => {
      const div = document.createElement("div");
      div.className = "order-row";
      div.textContent = `${it.name} ×${it.qty} = ${yen(it.price * it.qty)}`;
      orderListEl.appendChild(div);
    });
  }

  async function calcShipping(items, prefecture) {
    const pref = String(prefecture || "").trim();
    if (!pref) return 0;

    const r = await fetch("/api/shipping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, prefecture: pref }),
    });
    const j = await r.json().catch(() => ({}));
    console.log("[ISOYA][confirm.js] /api/shipping", r.status, j);

    if (!r.ok || !j || !j.ok) return 0;
    return safeNumber(j.fee, 0);
  }

  function withCacheBuster(url) {
    const v = "20251231_2"; // ★更新時に数字だけ変えればOK
    return url.includes("?") ? `${url}&v=${v}` : `${url}?v=${v}`;
  }

  (async function main() {
    try {
      setStatus("注文情報を読み込み中…");

      const order = readOrderFromStorage();
      console.log("[ISOYA][confirm.js] order object:", order);

      if (!order) {
        setStatus("注文情報が見つかりません。\n商品一覧からやり直してください。");
        if (cardBtn) cardBtn.disabled = true;
        if (codBtn) codBtn.disabled = true;
        return;
      }

      const items = normalizeItems(order);
      if (!items.length) {
        setStatus("カートが空です。");
        if (cardBtn) cardBtn.disabled = true;
        if (codBtn) codBtn.disabled = true;
        return;
      }

      // ✅ 住所（都道府県）が無いと送料が出せない
      const pref = String(order?.address?.prefecture || order?.address?.pref || "").trim();
      if (!pref) {
        setStatus("住所が未入力です。住所入力へ戻って保存してください。");
        if (cardBtn) cardBtn.disabled = true;
        if (codBtn) codBtn.disabled = true;
        return;
      }

      renderItems(items);

      const itemsTotal = items.reduce((s, it) => s + it.price * it.qty, 0);
      const shipping = await calcShipping(items, pref);

      // ✅ order に確定値を詰める（次画面へ渡す）
      order.items = items;
      order.itemsTotal = itemsTotal;
      order.shipping_fee = shipping;
      order.payment_method = ""; // まだ未確定

      saveOrder(order); // ★ここで一度保存しておく

      if (sumItemsEl) sumItemsEl.textContent = yen(itemsTotal);
      if (sumShippingEl) sumShippingEl.textContent = yen(shipping);
      if (sumCodEl) sumCodEl.textContent = `${COD_FEE}円（代引きの場合のみ）`;
      if (sumTotalCodEl) sumTotalCodEl.textContent = yen(itemsTotal + shipping + COD_FEE);

      setStatus("支払方法を選んでください。");

      if (backBtn) {
        backBtn.addEventListener("click", () => {
          // 住所画面へ
          location.href = withCacheBuster("./liff-address.html");
        });
      }

      if (codBtn) {
        codBtn.disabled = false;
        codBtn.addEventListener("click", () => {
          // ✅ クリック直前に必ず保存してから遷移（これが本丸）
          order.payment_method = "cod";
          saveOrder(order);
          location.href = withCacheBuster("./confirm-cod.html");
        });
      }

      if (cardBtn) {
        cardBtn.disabled = false;
        cardBtn.addEventListener("click", () => {
          order.payment_method = "card";
          saveOrder(order);
          location.href = withCacheBuster("./card-detail.html"); // あなたのカード明細ページ名に合わせてOK
        });
      }

    } catch (e) {
      console.error("[ISOYA][confirm.js] main error:", e);
      setStatus("エラー:\n" + (e?.message || String(e)));
      if (cardBtn) cardBtn.disabled = true;
      if (codBtn) codBtn.disabled = true;
    }
  })();
})();
