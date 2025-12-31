(function () {
  "use strict";

  const orderListEl   = document.getElementById("orderList");
  const sumItemsEl    = document.getElementById("sumItems");
  const sumShippingEl = document.getElementById("sumShipping");
  const sumCodEl      = document.getElementById("sumCod");
  const sumTotalEl    = document.getElementById("sumTotal");
  const statusEl      = document.getElementById("statusMsg");
  const backBtn       = document.getElementById("backBtn");
  const confirmBtn    = document.getElementById("confirmCod");

  const COD_FEE = 330;

  console.log("[ISOYA] confirm-cod.js LOADED", location.href, new Date().toISOString());
  window.addEventListener("error", (e) => console.error("[ISOYA] WINDOW ERROR:", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => console.error("[ISOYA] UNHANDLED:", e.reason));

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ""; }
  function yen(n) { return (Number(n) || 0).toLocaleString("ja-JP") + "円"; }
  function safeNumber(n, def = 0) { const x = Number(n); return Number.isFinite(x) ? x : def; }
  function safeJsonParse(s){ try { return JSON.parse(s); } catch { return null; } }

  function normalizeAddress(addr) {
    const a = addr || {};
    return {
      name: String(a.name || "").trim(),
      phone: String(a.phone || a.tel || "").trim(),
      postal: String(a.postal || a.zip || "").trim(),
      prefecture: String(a.prefecture || a.pref || "").trim(),
      city: String(a.city || "").trim(),
      address1: String(a.address1 || a.addr1 || "").trim(),
      address2: String(a.address2 || a.addr2 || "").trim(),
    };
  }

  function readOrderFromStorage() {
    const keys = ["orderDraft","currentOrder","order","confirm_normalized_order","lastOrder"];
    for (const k of keys) {
      const raw = sessionStorage.getItem(k) || localStorage.getItem(k);
      if (!raw) continue;
      const obj = safeJsonParse(raw);
      if (obj && typeof obj === "object") {
        console.log("[ISOYA] order loaded from:", k);
        return obj;
      }
    }
    return null;
  }

  function buildOrderRows(items) {
    if (!orderListEl) return;
    orderListEl.innerHTML = "";
    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "order-row";
      const subtotal = safeNumber(it.price, 0) * safeNumber(it.qty, 0);
      row.textContent = `${it.name} × ${it.qty} = ${yen(subtotal)}`;
      orderListEl.appendChild(row);
    });
  }

  async function fetchShipping(items, prefecture) {
    const pref = String(prefecture || "").trim();
    if (!pref) return 0;

    try {
      const res = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, prefecture: pref }),
      });
      const data = await res.json().catch(() => ({}));
      console.log("[ISOYA] /api/shipping result", res.status, data);
      if (res.ok && data && data.ok) return safeNumber(data.fee, 0);
    } catch (e) {
      console.error("[ISOYA] shipping fetch error:", e);
    }
    return 0;
  }

  async function main() {
    if (!confirmBtn) {
      setStatus("ERROR: confirmCod ボタンが見つかりません。HTMLの id を確認してください。");
      return;
    }

    // ★最初に必ず押せる状態にする（これが重要）
    confirmBtn.disabled = false;

    if (backBtn) backBtn.addEventListener("click", () => history.back());

    const order = readOrderFromStorage();
    console.log("[ISOYA] order object:", order);

    if (!order) {
      setStatus("注文情報が見つかりません。\n商品一覧→住所入力→確認の順で進んでください。");
      confirmBtn.disabled = true;
      return;
    }

    const itemsRaw = Array.isArray(order.items) ? order.items : [];
    const items = itemsRaw.map((it) => ({
      id: String(it.id || it.productId || "").trim(),
      name: String(it.name || it.id || "商品").trim(),
      price: safeNumber(it.price, 0),
      qty: safeNumber(it.qty || it.quantity, 0),
    })).filter((it) => it.id && it.qty > 0);

    if (!items.length) {
      setStatus("カートが空です。商品一覧から選び直してください。");
      confirmBtn.disabled = true;
      return;
    }

    const address = normalizeAddress(order.address || {});
    buildOrderRows(items);

    let itemsTotal = safeNumber(order.itemsTotal, 0);
    if (!itemsTotal) itemsTotal = items.reduce((s, it) => s + it.price * it.qty, 0);

    let shipping = safeNumber(order.shipping_fee ?? order.shipping ?? 0, 0);
    if (!shipping) shipping = await fetchShipping(items, address.prefecture);

    const finalTotal = itemsTotal + shipping + COD_FEE;

    if (sumItemsEl) sumItemsEl.textContent = yen(itemsTotal);
    if (sumShippingEl) sumShippingEl.textContent = yen(shipping);
    if (sumCodEl) sumCodEl.textContent = yen(COD_FEE);
    if (sumTotalEl) sumTotalEl.textContent = yen(finalTotal);

    // 住所が無いと困るので明示
    if (!address.prefecture || !address.city || !address.address1) {
      setStatus("住所情報が不完全です。\n住所入力に戻って保存してください。");
      // ただし「押せない」よりユーザー判断にするならここで disabled = true にしてOK
      confirmBtn.disabled = true;
      return;
    }

    setStatus("内容をご確認のうえ「代引きで注文を確定する」を押してください。");

    confirmBtn.addEventListener("click", async () => {
      try {
        if (confirmBtn.disabled) return;

        confirmBtn.disabled = true;
        setStatus("ご注文を確定しています…");

        const orderForCod = {
          items,
          itemsTotal,
          shipping_fee: shipping,
          codFee: COD_FEE,
          finalTotal,
          paymentMethod: "cod",
          payment: "cod",
          lineUserId: String(order.lineUserId || "").trim(),
          lineUserName: String(order.lineUserName || "").trim(),
          address,
        };

        sessionStorage.setItem("lastOrder", JSON.stringify(orderForCod));

        const res = await fetch("/api/order/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(orderForCod),
        });
        const data = await res.json().catch(() => ({}));
        console.log("[ISOYA] /api/order/complete result", res.status, data);

        if (!res.ok || !data || !data.ok) {
          setStatus("ご注文の確定に失敗しました。\nサーバー応答: " + (data?.error || res.status));
          confirmBtn.disabled = false;
          return;
        }

        location.href = "./cod-complete.html";
      } catch (e) {
        console.error("[ISOYA] CLICK ERROR:", e);
        setStatus("エラー:\n" + (e?.message || String(e)));
        confirmBtn.disabled = false;
      }
    }, { once: true });

  }

  main();
})();
