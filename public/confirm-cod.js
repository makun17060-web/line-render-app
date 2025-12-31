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

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ""; }
  function yen(n) { return (Number(n) || 0).toLocaleString("ja-JP") + "円"; }
  function safeNumber(n, def = 0) { const x = Number(n); return Number.isFinite(x) ? x : def; }
  function safeJsonParse(s){ try { return JSON.parse(s); } catch { return null; } }

  function readOrderFromStorage() {
    const keys = ["orderDraft","currentOrder","order","confirm_normalized_order","lastOrder"];
    for (const k of keys) {
      const raw = sessionStorage.getItem(k) || localStorage.getItem(k);
      if (!raw) continue;
      const obj = safeJsonParse(raw);
      if (obj && typeof obj === "object") return obj;
    }
    return null;
  }

  async function fetchShipping(items, prefecture) {
    const pref = String(prefecture || "").trim();
    if (!pref) return 0;
    const res = await fetch("/api/shipping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, prefecture: pref }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.ok) return safeNumber(data.fee, 0);
    return 0;
  }

  function renderItems(items) {
    orderListEl.innerHTML = "";
    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "order-row";
      row.textContent = `${it.name} × ${it.qty} = ${yen(it.price * it.qty)}`;
      orderListEl.appendChild(row);
    });
  }

  (async function main() {
    if (!confirmBtn) {
      setStatus("ERROR: confirmCod ボタンが見つかりません。");
      return;
    }

    confirmBtn.disabled = false;
    backBtn?.addEventListener("click", () => history.back());

    const order = readOrderFromStorage();
    console.log("[ISOYA] order object:", order);

    if (!order) {
      setStatus("注文情報が見つかりません。\n商品一覧 → 住所入力 → 確認 の順で進んでください。");
      confirmBtn.disabled = true;
      return;
    }

    const items = (order.items || []).map((it) => ({
      id: String(it.id || "").trim(),
      name: String(it.name || it.id || "商品").trim(),
      price: safeNumber(it.price, 0),
      qty: safeNumber(it.qty, 0),
    })).filter((it) => it.id && it.qty > 0);

    if (!items.length) {
      setStatus("カートが空です。");
      confirmBtn.disabled = true;
      return;
    }

    const addr = order.address || {};
    if (!addr.prefecture || !addr.city || !addr.address1 || !addr.name || !addr.phone || !addr.postal) {
      setStatus("住所情報が不完全です。\n住所入力に戻って保存してください。");
      confirmBtn.disabled = true;
      return;
    }

    renderItems(items);

    const itemsTotal = items.reduce((s, it) => s + it.price * it.qty, 0);
    let shipping = safeNumber(order.shipping_fee ?? order.shipping ?? 0, 0);
    if (!shipping) shipping = await fetchShipping(items, addr.prefecture);

    const finalTotal = itemsTotal + shipping + COD_FEE;

    sumItemsEl.textContent = yen(itemsTotal);
    sumShippingEl.textContent = yen(shipping);
    sumCodEl.textContent = yen(COD_FEE);
    sumTotalEl.textContent = yen(finalTotal);

    setStatus("内容をご確認のうえ「代引きで注文を確定する」を押してください。");

    confirmBtn.addEventListener("click", async () => {
      try {
        if (confirmBtn.disabled) return;
        confirmBtn.disabled = true;
        setStatus("ご注文を確定しています…");

        const payload = {
          items,
          itemsTotal,
          shipping_fee: shipping,
          codFee: COD_FEE,
          finalTotal,
          paymentMethod: "cod",
          lineUserId: String(order.lineUserId || "").trim(),
          lineUserName: String(order.lineUserName || "").trim(),
          address: addr,
        };

        const res = await fetch("/api/order/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        console.log("[ISOYA] /api/order/complete", res.status, data);

        if (!res.ok || !data.ok) {
          setStatus("確定に失敗しました:\n" + (data.error || res.status));
          confirmBtn.disabled = false;
          return;
        }

        setStatus("注文を受け付けました。ありがとうございます。");
        location.href = "./cod-complete.html";
      } catch (e) {
        setStatus("エラー:\n" + (e?.message || String(e)));
        confirmBtn.disabled = false;
      }
    }, { once: true });

  })();
})();
