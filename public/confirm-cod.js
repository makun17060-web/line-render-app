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

  // server-line.js 側と合わせる（envにしているならHTMLへ埋め込む形でもOK）
  const COD_FEE = 330;

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
      // サーバー側は a.zip/a.postal, a.prefecture/a.pref, a.city, a.addr1/a.address1, a.addr2/a.address2, a.tel/a.phone を見る
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

  async function fetchShippingIfNeeded(items, address, shipping) {
    // shipping が 0 の場合のみ再計算（住所が空ならそもそも計算できないのでスキップ）
    if (shipping > 0) return shipping;

    const hasPref = !!String(address?.prefecture || address?.pref || "").trim();
    if (!hasPref) return shipping;

    try {
      const res = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, address }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok) {
        return safeNumber(data.shipping, shipping);
      }
    } catch (e) {
      console.error("shipping fetch error:", e);
    }
    return shipping;
  }

  async function main() {
    const raw = sessionStorage.getItem("orderDraft");
    if (!raw) {
      setStatus("注文情報が見つかりませんでした。\n商品一覧からやり直してください。");
      if (confirmBtn) confirmBtn.disabled = true;
      return;
    }

    let order;
    try {
      order = JSON.parse(raw);
    } catch (e) {
      console.error("orderDraft parse error:", e);
      setStatus("注文情報の読み込みに失敗しました。");
      if (confirmBtn) confirmBtn.disabled = true;
      return;
    }

    const itemsRaw = Array.isArray(order.items) ? order.items : [];
    const items = itemsRaw
      .map((it) => ({
        id: String(it.id || "").trim(),
        name: String(it.name || it.id || "商品").trim(),
        price: safeNumber(it.price, 0),
        qty: safeNumber(it.qty, 0),
      }))
      .filter((it) => it.qty > 0);

    const address = normalizeAddress(order.address || {});
    let itemsTotal = safeNumber(order.itemsTotal, 0);
    let shipping = safeNumber(order.shipping, 0);

    if (!items.length) {
      setStatus("カートに商品が入っていません。");
      if (confirmBtn) confirmBtn.disabled = true;
      return;
    }

    buildOrderRows(items);

    // itemsTotal が無ければ再計算
    if (!itemsTotal) {
      itemsTotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
    }

    // shipping が 0 の場合は /api/shipping で確認（住所がある時だけ）
    shipping = await fetchShippingIfNeeded(items, address, shipping);

    const finalTotal = itemsTotal + shipping + COD_FEE;

    if (sumItemsEl)    sumItemsEl.textContent    = yen(itemsTotal);
    if (sumShippingEl) sumShippingEl.textContent = yen(shipping);
    if (sumCodEl)      sumCodEl.textContent      = yen(COD_FEE);
    if (sumTotalEl)    sumTotalEl.textContent    = yen(finalTotal);

    setStatus("内容をご確認のうえ「代引きで注文を確定する」を押してください。");

    if (backBtn) {
      backBtn.addEventListener("click", () => history.back());
    }

    if (confirmBtn) {
      // 二重送信防止（複数回 addEventListener されるのも防ぐ）
      confirmBtn.addEventListener("click", async () => {
        if (confirmBtn.disabled) return;

        confirmBtn.disabled = true;
        setStatus("ご注文を確定しています…");

        // ★重要：server-line.js の /api/order/complete は paymentMethod / payment を見て
        // cod/bank/stripe を判定しているので、必ず cod を送る
        const orderForCod = {
          items,
          itemsTotal,
          shipping,
          codFee: COD_FEE,
          finalTotal,

          // ★ここが修正点（最重要）
          paymentMethod: "cod",   // serverが order.paymentMethod を読む
          payment: "cod",         // 念のため互換で両方入れる

          // LINE情報（あれば）
          lineUserId: String(order.lineUserId || "").trim(),
          lineUserName: String(order.lineUserName || "").trim(),

          address,
        };

        sessionStorage.setItem("lastOrder", JSON.stringify(orderForCod));

        try {
          const res = await fetch("/api/order/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(orderForCod),
          });
          const data = await res.json().catch(() => ({}));

          if (!res.ok || !data || !data.ok) {
            console.error("/api/order/complete error:", data);
            setStatus("ご注文の確定に失敗しました。\n時間をおいて再度お試しください。");
            confirmBtn.disabled = false;
            return;
          }

          // 成功 → 完了画面へ
          location.href = "./cod-complete.html";
        } catch (e) {
          console.error("/api/order/complete exception:", e);
          setStatus("通信エラーが発生しました。\n時間をおいて再度お試しください。");
          confirmBtn.disabled = false;
        }
      }, { once: true }); // ★同一ページで再実行されても多重登録しない
    }
  }

  main();
})();
