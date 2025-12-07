(function () {
  "use strict";

  const orderListEl   = document.getElementById("orderList");
  const sumItemsEl    = document.getElementById("sumItems");
  const sumShippingEl = document.getElementById("sumShipping");
  const sumTotalEl    = document.getElementById("sumTotal");
  const statusEl      = document.getElementById("statusMsg");
  const backBtn       = document.getElementById("backBtn");
  const confirmBtn    = document.getElementById("confirmCard");

  function setStatus(msg) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
  }

  function yen(n) {
    return (Number(n) || 0).toLocaleString("ja-JP") + "円";
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

    const items     = Array.isArray(order.items) ? order.items : [];
    const address   = order.address || {};
    let itemsTotal  = Number(order.itemsTotal || 0);
    let shipping    = Number(order.shipping || 0);
    let finalTotal  = 0;

    if (!items.length) {
      setStatus("カートに商品が入っていません。");
      if (confirmBtn) confirmBtn.disabled = true;
      return;
    }

    // 商品一覧
    if (orderListEl) {
      orderListEl.innerHTML = "";
      items.forEach((it) => {
        const row = document.createElement("div");
        row.className = "row";
        const name = it.name || it.id || "商品";
        const price = Number(it.price) || 0;
        const qty = Number(it.qty) || 0;
        const subtotal = price * qty;
        row.textContent = `${name} × ${qty} = ${yen(subtotal)}`;
        orderListEl.appendChild(row);
      });
    }

    // itemsTotal が無ければ再計算
    if (!itemsTotal) {
      itemsTotal = items.reduce(
        (sum, it) =>
          sum + (Number(it.price) || 0) * (Number(it.qty) || 0),
        0
      );
    }

    // 送料が 0 の場合は一応 /api/shipping で確認
    if (!shipping) {
      try {
        const res = await fetch("/api/shipping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items, address }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.ok) {
          shipping = Number(data.shipping || 0);
        }
      } catch (e) {
        console.error("shipping fetch error:", e);
      }
    }

    finalTotal = itemsTotal + shipping;

    if (sumItemsEl)    sumItemsEl.textContent    = yen(itemsTotal);
    if (sumShippingEl) sumShippingEl.textContent = yen(shipping);
    if (sumTotalEl)    sumTotalEl.textContent    = yen(finalTotal);

    setStatus("内容をご確認のうえ「クレジットで支払う」を押してください。");

    // 戻るボタン
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        history.back();
      });
    }

    // 決済実行
    if (confirmBtn) {
      confirmBtn.addEventListener("click", async () => {
        confirmBtn.disabled = true;
        setStatus("決済画面を開いています…");

        const orderForStripe = {
          items,
          itemsTotal,
          shipping,
          codFee: 0,
          finalTotal,
          lineUserId: order.lineUserId || "",
          lineUserName: order.lineUserName || "",
          address,
        };

        // 後で /api/order/complete 用に保存（成功ページで使う想定なら）
        sessionStorage.setItem("lastOrder", JSON.stringify(orderForStripe));

        try {
          const res = await fetch("/api/pay-stripe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(orderForStripe),
          });
          const data = await res.json().catch(() => ({}));

          if (!res.ok || !data || !data.ok || !data.checkoutUrl) {
            console.error("/api/pay-stripe error:", data);
            setStatus("決済の開始に失敗しました。\n時間をおいて再度お試しください。");
            confirmBtn.disabled = false;
            return;
          }

          // Stripe のチェックアウト画面へ遷移
          location.href = data.checkoutUrl;
        } catch (e) {
          console.error("/api/pay-stripe exception:", e);
          setStatus("通信エラーが発生しました。\n時間をおいて再度お試しください。");
          confirmBtn.disabled = false;
        }
      });
    }
  }

  main();
})();
