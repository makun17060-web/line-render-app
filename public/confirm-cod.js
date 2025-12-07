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

    finalTotal = itemsTotal + shipping + COD_FEE;

    if (sumItemsEl)    sumItemsEl.textContent    = yen(itemsTotal);
    if (sumShippingEl) sumShippingEl.textContent = yen(shipping);
    if (sumCodEl)      sumCodEl.textContent      = yen(COD_FEE);
    if (sumTotalEl)    sumTotalEl.textContent    = yen(finalTotal);

    setStatus("内容をご確認のうえ「代引きで注文を確定する」を押してください。");

    if (backBtn) {
      backBtn.addEventListener("click", () => {
        history.back();
      });
    }

    if (confirmBtn) {
      confirmBtn.addEventListener("click", async () => {
        confirmBtn.disabled = true;
        setStatus("ご注文を確定しています…");

        const orderForCod = {
          items,
          itemsTotal,
          shipping,
          codFee: COD_FEE,
          finalTotal,
          lineUserId: order.lineUserId || "",
          lineUserName: order.lineUserName || "",
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
      });
    }
  }

  main();
})();
