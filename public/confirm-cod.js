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

  // ===== ISOYA DEBUG MARK =====
  console.log("[ISOYA] confirm-cod.js LOADED", location.href, new Date().toISOString());
  window.addEventListener("error", (e) => console.error("[ISOYA] WINDOW ERROR:", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => console.error("[ISOYA] UNHANDLED:", e.reason));

  function setStatus(msg) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
  }

  function yen(n) {
    return (Number(n) || 0).toLocaleString("ja-JP") + "円";
  }

  function safeNumber(n, def = 0) {
    const x = Number(n);
    return Number.isFinite(x) ? x : def;
  }

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

  function buildOrderRows(items) {
    if (!orderListEl) return;
    orderListEl.innerHTML = "";
    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "row";
      const name = String(it.name || it.id || "商品");
      const price = safeNumber(it.price, 0);
      const qty = safeNumber(it.qty, 0);
      const subtotal = price * qty;
      row.textContent = `${name} × ${qty} = ${yen(subtotal)}`;
      orderListEl.appendChild(row);
    });
  }

  // ✅ products.html 側の保存キーにも対応（orderDraft / isoya_checkout_v1 / isoya_checkout）
  function loadDraft() {
    const keys = ["orderDraft", "isoya_checkout_v1", "isoya_checkout"];
    for (const k of keys) {
      const raw = sessionStorage.getItem(k);
      if (raw) {
        console.log("[ISOYA] draft found key=", k);
        return { key: k, raw };
      }
    }
    return { key: "", raw: "" };
  }

  // ✅ products.html の payload（items/subtotal）と、従来の payload（itemsTotal/shipping/address）両対応にする
  function normalizeDraftOrder(order) {
    const o = order || {};

    // items：[{id,name,price,qty}] を作る
    const itemsRaw = Array.isArray(o.items) ? o.items : [];
    const items = itemsRaw
      .map((it) => ({
        id: String(it.id || "").trim(),
        name: String(it.name || it.id || "商品").trim(),
        price: safeNumber(it.price, 0),
        qty: safeNumber(it.qty ?? it.count ?? it.quantity, 0),
      }))
      .filter((it) => it.id && it.qty > 0);

    // itemsTotal：無ければ items から計算 or subtotal を使う
    let itemsTotal = safeNumber(o.itemsTotal, 0);
    if (!itemsTotal) itemsTotal = safeNumber(o.subtotal, 0);
    if (!itemsTotal) itemsTotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);

    // shipping：無ければ 0（後で必要なら /api/shipping で計算）
    let shipping = safeNumber(o.shipping, 0);

    // address：無ければ空
    const address = normalizeAddress(o.address || {});

    return {
      items,
      itemsTotal,
      shipping,
      address,
      // あるなら拾う（無くてもOK）
      lineUserId: String(o.lineUserId || o.userId || "").trim(),
      lineUserName: String(o.lineUserName || o.displayName || "").trim(),
    };
  }

  async function fetchShippingIfNeeded(items, address, shipping) {
    // shipping が 0 の場合のみ再計算（住所が空なら計算できないのでスキップ）
    if (shipping > 0) return shipping;

    const hasPref = !!String(address?.prefecture || "").trim();
    if (!hasPref) return shipping;

    try {
      const res = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, address }),
      });
      const data = await res.json().catch(() => ({}));
      console.log("[ISOYA] /api/shipping result", res.status, data);
      if (res.ok && data && data.ok) {
        return safeNumber(data.shipping, shipping);
      }
    } catch (e) {
      console.error("[ISOYA] shipping fetch error:", e);
    }
    return shipping;
  }

  async function main() {
    try {
      if (!confirmBtn) {
        setStatus("ボタン要素が見つかりません（confirmCod）");
        return;
      }

      const { raw } = loadDraft();
      console.log("[ISOYA] draft raw:", raw);

      if (!raw) {
        setStatus("注文情報が見つかりませんでした。\n商品一覧からやり直してください。");
        confirmBtn.disabled = true;
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        console.error("[ISOYA] draft parse error:", e);
        setStatus("注文情報の読み込みに失敗しました（JSON不正）。");
        confirmBtn.disabled = true;
        return;
      }

      const draft = normalizeDraftOrder(parsed);

      if (!draft.items.length) {
        setStatus("カートに商品が入っていません。");
        confirmBtn.disabled = true;
        return;
      }

      buildOrderRows(draft.items);

      // 送料計算（住所があれば /api/shipping で再計算）
      draft.shipping = await fetchShippingIfNeeded(draft.items, draft.address, draft.shipping);

      const finalTotal = draft.itemsTotal + draft.shipping + COD_FEE;

      if (sumItemsEl)    sumItemsEl.textContent    = yen(draft.itemsTotal);
      if (sumShippingEl) sumShippingEl.textContent = yen(draft.shipping);
      if (sumCodEl)      sumCodEl.textContent      = yen(COD_FEE);
      if (sumTotalEl)    sumTotalEl.textContent    = yen(finalTotal);

      setStatus("内容をご確認のうえ「代引きで注文を確定する」を押してください。");

      if (backBtn) {
        backBtn.addEventListener("click", () => history.back());
      }

      confirmBtn.addEventListener("click", async () => {
        try {
          if (confirmBtn.disabled) return;

          confirmBtn.disabled = true;
          setStatus("ご注文を確定しています…");

          const orderForCod = {
            items: draft.items,
            itemsTotal: draft.itemsTotal,
            shipping: draft.shipping,
            codFee: COD_FEE,
            finalTotal,
            paymentMethod: "cod",
            payment: "cod",
            lineUserId: draft.lineUserId,
            lineUserName: draft.lineUserName,
            address: draft.address,
          };

          // デバッグ用に保存
          try { sessionStorage.setItem("lastOrder", JSON.stringify(orderForCod)); } catch {}

          console.log("[ISOYA] ABOUT TO POST /api/order/complete", orderForCod);

          const res = await fetch("/api/order/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(orderForCod),
          });

          const data = await res.json().catch(() => ({}));
          console.log("[ISOYA] /api/order/complete result", res.status, data);

          if (!res.ok || !data || !data.ok) {
            const msg = data?.error ? `\n${data.error}` : "";
            setStatus("ご注文の確定に失敗しました。\n（サーバー応答エラー）" + msg);
            confirmBtn.disabled = false;
            return;
          }

          // ✅ /public 配下運用に寄せて確実に遷移（ファイル名はあなたの実体に合わせて）
          // cod-complete.html が /public/cod-complete.html にあるならこれでOK
          location.href = "/public/cod-complete.html";
        } catch (e) {
          console.error("[ISOYA] CLICK HANDLER ERROR:", e);
          setStatus("通信または画面内エラーで停止しました:\n" + (e?.message || String(e)));
          confirmBtn.disabled = false;
        }
      }, { once: true });

    } catch (e) {
      console.error("[ISOYA] main error:", e);
      setStatus("画面の初期化でエラーが発生しました:\n" + (e?.message || String(e)));
      if (confirmBtn) confirmBtn.disabled = true;
    }
  }

  main();
})();
