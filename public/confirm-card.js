// confirm-card.js — クレジット専用

(async function () {

  const orderListEl = document.getElementById("orderList");
  const totalEl = document.getElementById("cardTotal");

  function yen(n){ return `${Number(n||0).toLocaleString()}円`; }

  // ===== 注文情報の取得 =====
  const raw =
    sessionStorage.getItem("orderData") ||
    sessionStorage.getItem("miniappOrder") ||
    sessionStorage.getItem("currentOrder") ||
    sessionStorage.getItem("liffOrder");

  if (!raw) {
    orderListEl.innerHTML = "<p>注文情報がありません。</p>";
    return;
  }

  const data = JSON.parse(raw).data;
  const items = data.items || data.cart;

  let itemsTotal = 0;
  orderListEl.innerHTML = "";

  items.forEach(it => {
    const price = Number(it.price || it.unitPrice);
    const qty   = Number(it.qty || it.quantity);
    const row = document.createElement("div");
    row.textContent = `${it.name} × ${qty}個 = ${yen(price * qty)}`;
    orderListEl.appendChild(row);

    itemsTotal += price * qty;
  });

  const shipping = Number(data.shipping || 0);
  const total = itemsTotal + shipping;

  totalEl.textContent = yen(total);

  // ===== Stripe 決済開始 =====
  document.getElementById("confirmCard").onclick = async () => {
    const payload = {
      lineUserId: data.lineUserId,
      lineUserName: data.lineUserName,
      items: items.map(it => ({
        id: it.id, name: it.name,
        price: Number(it.price), qty: Number(it.qty)
      })),
      itemsTotal,
      shipping,
      codFee: 0,
      finalTotal: total,
      payment: "card",
      address: data.address,
    };

    localStorage.setItem("lastStripeOrder", JSON.stringify(payload));

    const res = await fetch("/api/pay-stripe", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    const result = await res.json();
    location.href = result.checkoutUrl;
  };

})();
