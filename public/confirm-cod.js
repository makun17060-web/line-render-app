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
  function safeNumber(n, def = 0){ const x = Number(n); return Number.isFinite(x) ? x : def; }

  function safeJsonParse(raw){
    try {
      if (!raw) return null;
      if (typeof raw === "object") return raw;
      return JSON.parse(String(raw));
    } catch {
      return null;
    }
  }

  // ✅ 壊れたJSON文字列（末尾に余計な " が付いてる等）を軽く救済
  function tryRepairJsonString(s){
    if (typeof s !== "string") return s;
    const t = s.trim();
    if (!t) return t;

    // よくある： ...}"} みたいな末尾の余計な " を削る
    const repaired = t.replace(/"+\s*$/, "");
    return repaired;
  }

  function readOrderFromStorage() {
    // ✅ 遷移元が色々でも拾えるようにキーを増やす
    const keys = [
      "orderDraft",
      "orderDraft_backup",
      "orderDraft_v2",
      "currentOrder",
      "order",
      "confirm_normalized_order",
      "lastOrder",
      "isoya_order",
      "isoya_order_v2"
    ];

    // ✅ localStorage 優先（sessionStorage は LIFF/ブラウザで消えやすい）
    for (const store of [localStorage, sessionStorage]) {
      for (const k of keys) {
        const raw = store.getItem(k);
        if (!raw) continue;

        // まず通常パース
        let obj = safeJsonParse(raw);
        if (obj && typeof obj === "object") return obj;

        // 次に修復して再パース
        const repaired = tryRepairJsonString(raw);
        obj = safeJsonParse(repaired);
        if (obj && typeof obj === "object") return obj;
      }
    }
    return null;
  }

  function saveOrder(order) {
    const s = JSON.stringify(order);
    // ✅ 重要：localStorage にも必ず入れる
    localStorage.setItem("orderDraft", s);
    localStorage.setItem("orderDraft_backup", s);
    localStorage.setItem("isoya_order_v2", s);

    sessionStorage.setItem("orderDraft", s);
    sessionStorage.setItem("order", s);
    sessionStorage.setItem("currentOrder", s);
    sessionStorage.setItem("confirm_normalized_order", s);
  }

  function normalizeItems(order) {
    const rawItems = Array.isArray(order?.items) ? order.items : [];
    return rawItems
      .map((it) => ({
        id: String(it.id || it.productId || "").trim(),
        name: String(it.name || it.id || "商品").trim(),
        price: safeNumber(it.price, 0),
        qty: safeNumber(it.qty ?? it.quantity, 0),
      }))
      .filter((it) => it.id && it.qty > 0);
  }

  function buildOrderRows(items) {
    if (!orderListEl) return;
    orderListEl.innerHTML = "";
    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "row";
      row.textContent = `${it.name} × ${it.qty} = ${yen(it.price * it.qty)}`;
      orderListEl.appendChild(row);
    });
  }

  async function calcShipping(items, prefecture) {
    const pref = String(prefecture||"").trim();
    if (!pref) return 0;

    const res = await fetch("/api/shipping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, prefecture: pref })
    });
    const data = await res.json().catch(() => ({}));
    console.log("[ISOYA] /api/shipping", res.status, data);
    if (res.ok && data && data.ok) return safeNumber(data.fee ?? data.shipping, 0);
    return 0;
  }

  async function main() {
    try {
      if (!confirmBtn) {
        setStatus("ボタン要素が見つかりません（confirmCod）");
        return;
      }

      confirmBtn.disabled = true;

      const order = readOrderFromStorage();
      console.log("[ISOYA] order object:", order);

      if (!order) {
        setStatus(
          "注文情報が見つかりませんでした。\n\n" +
          "原因：confirm.html → confirm-cod.html に来る直前の保存が足りない可能性があります。\n" +
          "対処：ひとつ前の確認画面へ戻って、もう一度「代引き」を押してください。"
        );
        confirmBtn.disabled = true;
        return;
      }

      const items = normalizeItems(order);
      if (!items.length) {
        setStatus("カートに商品が入っていません。");
        confirmBtn.disabled = true;
        return;
      }

      const pref = String(order.address?.prefecture || order.address?.pref || "").trim();
      if (!pref) {
        setStatus("住所が未入力です。住所入力へ戻って保存してください。");
        confirmBtn.disabled = true;
        return;
      }

      buildOrderRows(items);

      const itemsTotal = safeNumber(order.itemsTotal, items.reduce((s, it) => s + it.price * it.qty, 0));

      let shipping = safeNumber(order.shipping_fee ?? order.shipping ?? 0, 0);
      if (!shipping) shipping = await calcShipping(items, pref);

      const finalTotal = itemsTotal + shipping + COD_FEE;

      if (sumItemsEl)    sumItemsEl.textContent    = yen(itemsTotal);
      if (sumShippingEl) sumShippingEl.textContent = yen(shipping);
      if (sumCodEl)      sumCodEl.textContent      = yen(COD_FEE);
      if (sumTotalEl)    sumTotalEl.textContent    = yen(finalTotal);

      // ✅ 次の確定APIのために、ここで“強制的に”保存し直す
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
            setStatus("ご注文の確定に失敗しました。\n" + (data?.error ? `理由：${data.error}` : "（サーバー応答エラー）"));
            confirmBtn.disabled = false;
            return;
          }

          // ✅ 完了へ
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
