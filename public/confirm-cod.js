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
  function safeJsonParse(s){ try { return JSON.parse(s); } catch { return null; } }
  function safeNumber(n, def = 0){ const x = Number(n); return Number.isFinite(x) ? x : def; }

  function readOrderFromStorage() {
    const keys = [
      "orderDraft","currentOrder","order","confirm_normalized_order","lastOrder"
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
    sessionStorage.setItem("orderDraft", JSON.stringify(order));
    sessionStorage.setItem("order", JSON.stringify(order));
    sessionStorage.setItem("currentOrder", JSON.stringify(order));
    sessionStorage.setItem("confirm_normalized_order", JSON.stringify(order));
    localStorage.setItem("order", JSON.stringify(order));
  }

  function buildOrderRows(items) {
    if (!orderListEl) return;
    orderListEl.innerHTML = "";
    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "row";
      const name = String(it.name || it.id || "商品");
      const price = safeNumber(it.price, 0);
      const qty = safeNumber(it.qty, 0);
      row.textContent = `${name} × ${qty} = ${yen(price * qty)}`;
      orderListEl.appendChild(row);
    });
  }

  async function calcShipping(items, prefecture) {
    const pref = String(prefecture||"").trim();
    if (!pref) return 0;

    const res = await fetch("/api/shipping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, prefecture: pref }) // ★サーバ仕様
    });
    const data = await res.json().catch(() => ({}));
    console.log("[ISOYA] /api/shipping", res.status, data);
    if (res.ok && data && data.ok) return safeNumber(data.fee, 0);
    return 0;
  }

  async function main() {
    try {
      if (!confirmBtn) {
        setStatus("ボタン要素が見つかりません（confirmCod）");
        return;
      }

      const order = readOrderFromStorage();
      console.log("[ISOYA] order object:", order);

      if (!order) {
        setStatus("注文情報が見つかりませんでした。\n商品一覧からやり直してください。");
        confirmBtn.disabled = true;
        return;
      }

      const items = (Array.isArray(order.items) ? order.items : [])
        .map((it) => ({
          id: String(it.id || "").trim(),
          name: String(it.name || it.id || "商品").trim(),
          price: safeNumber(it.price, 0),
          qty: safeNumber(it.qty, 0),
        }))
        .filter((it) => it.id && it.qty > 0);

      if (!items.length) {
        setStatus("カートに商品が入っていません。");
        confirmBtn.disabled = true;
        return;
      }

      const pref = String(order.address?.prefecture || "").trim();
      if (!pref) {
        setStatus("住所が未入力です。住所入力へ戻って保存してください。");
        confirmBtn.disabled = true;
        return;
      }

      buildOrderRows(items);

      const itemsTotal = safeNumber(order.itemsTotal, items.reduce((s, it) => s + it.price * it.qty, 0));

      // 送料は confirm.html で入れているはず → 無ければここで再計算
      let shipping = safeNumber(order.shipping_fee ?? order.shipping ?? 0, 0);
      if (!shipping) shipping = await calcShipping(items, pref);

      const finalTotal = itemsTotal + shipping + COD_FEE;

      // 画面反映
      if (sumItemsEl)    sumItemsEl.textContent    = yen(itemsTotal);
      if (sumShippingEl) sumShippingEl.textContent = yen(shipping);
      if (sumCodEl)      sumCodEl.textContent      = yen(COD_FEE);
      if (sumTotalEl)    sumTotalEl.textContent    = yen(finalTotal);

      // 保存（次のAPI用）
      order.itemsTotal = itemsTotal;
      order.shipping_fee = shipping;
      saveOrder(order);

      setStatus("内容をご確認のうえ「代引きで注文を確定する」を押してください。");

      if (backBtn) backBtn.addEventListener("click", () => location.href = "./confirm.html");

      confirmBtn.disabled = false;
      confirmBtn.addEventListener("click", async () => {
        try {
          confirmBtn.disabled = true;
          setStatus("ご注文を確定しています…");

          const payload = {
            items,
            itemsTotal,
            shipping_fee: shipping,
            cod_fee: COD_FEE,
            total: finalTotal,
            payment_method: "cod",
            address: order.address || null,
            lineUserId: String(order.lineUserId || "").trim(),
            lineUserName: String(order.lineUserName || "").trim(),
          };

          console.log("[ISOYA] POST /api/order/complete", payload);

          const res = await fetch("/api/order/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          const data = await res.json().catch(() => ({}));
          console.log("[ISOYA] /api/order/complete", res.status, data);

          if (!res.ok || !data || !data.ok) {
            setStatus("ご注文の確定に失敗しました。\n（サーバー応答エラー）");
            confirmBtn.disabled = false;
            return;
          }

          location.href = "./cod-complete.html";
        } catch (e) {
          console.error("[ISOYA] confirm click error:", e);
          setStatus("通信または画面内エラー:\n" + (e?.message || String(e)));
          confirmBtn.disabled = false;
        }
      }, { once: true });

    } catch (e) {
      console.error("[ISOYA] main error:", e);
      setStatus("画面の初期化でエラー:\n" + (e?.message || String(e)));
      if (confirmBtn) confirmBtn.disabled = true;
    }
  }

  main();
})();
