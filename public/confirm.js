(function () {
  "use strict";

  const orderListEl   = document.getElementById("orderList");
  const sumItemsEl    = document.getElementById("sumItems");
  const sumShippingEl = document.getElementById("sumShipping");
  const sumTotalCodEl = document.getElementById("sumTotalCod");
  const statusEl      = document.getElementById("statusMsg");
  const cardBtn       = document.getElementById("cardBtn");
  const codBtn        = document.getElementById("codBtn");
  const backBtn       = document.getElementById("backBtn");

  const COD_FEE = 330;

  function setStatus(msg) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
  }

  function yen(n) {
    return (Number(n) || 0).toLocaleString("ja-JP") + "円";
  }

  function disableButtons() {
    if (cardBtn) cardBtn.disabled = true;
    if (codBtn)  codBtn.disabled  = true;
  }

  async function main() {
    const raw = sessionStorage.getItem("orderDraft");
    if (!raw) {
      setStatus("注文情報が見つかりませんでした。\n商品一覧からやり直してください。");
      if (orderListEl) orderListEl.textContent = "";
      disableButtons();
      return;
    }

    let order;
    try {
      order = JSON.parse(raw);
    } catch (e) {
      console.error("orderDraft parse error:", e);
      setStatus("注文情報の読み込みに失敗しました。\nお手数ですが最初からやり直してください。");
      disableButtons();
      return;
    }

    const items   = Array.isArray(order.items) ? order.items : [];
    const address = order.address || {};

    if (!items.length) {
      setStatus("カートに商品が入っていません。");
      disableButtons();
      return;
    }

    // 商品一覧表示
    if (orderListEl) {
      orderListEl.innerHTML = "";
      items.forEach((it) => {
        const row = document.createElement("div");
        row.className = "order-row";
        const name = it.name || it.id || "商品";
        const price = Number(it.price) || 0;
        const qty = Number(it.qty) || 0;
        const subtotal = price * qty;
        row.textContent = `${name} × ${qty} = ${yen(subtotal)}`;
        orderListEl.appendChild(row);
      });
    }

    // 商品合計
    const itemsTotal = items.reduce(
      (sum, it) =>
        sum + (Number(it.price) || 0) * (Number(it.qty) || 0),
      0
    );

    // 送料計算（/api/shipping を使う）
    let shipping = 0;
    let region = "";

    try {
      setStatus("送料を計算しています…");

      const res = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          address, // prefecture などから地域を判定
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok) {
        shipping = Number(data.shipping || 0);
        region   = data.region || "";
      } else {
        console.error("/api/shipping error response:", data);
        setStatus("送料の計算に失敗しました。\n地域が未入力の可能性があります。");
      }
    } catch (e) {
      console.error("/api/shipping error:", e);
      setStatus("送料の計算中にエラーが発生しました。");
    }

    const finalTotalCard = itemsTotal + shipping;
    const finalTotalCod  = itemsTotal + shipping + COD_FEE;

    // 表示更新
    if (sumItemsEl)    sumItemsEl.textContent    = yen(itemsTotal);
    if (sumShippingEl) sumShippingEl.textContent = yen(shipping);
    if (sumTotalCodEl) sumTotalCodEl.textContent = yen(finalTotalCod);

    // orderDraft を更新して保存（次の画面で再利用）
    const newOrder = {
      ...order,
      itemsTotal,
      shipping,
      region,
      codFee: COD_FEE,
      finalTotalCard,
      finalTotalCod,
    };
    sessionStorage.setItem("orderDraft", JSON.stringify(newOrder));

    setStatus("お支払い方法を選択してください。");

    // ボタン動作
    if (cardBtn) {
      cardBtn.disabled = false;
      cardBtn.addEventListener("click", () => {
        location.href = "./confirm-card.html";
      });
    }
    if (codBtn) {
      codBtn.disabled = false;
      codBtn.addEventListener("click", () => {
        location.href = "./confirm-cod.html";
      });
    }
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        // 住所入力画面に戻す想定
        location.href = "./liff-address.html";
      });
    }
  }

  main();
})();
