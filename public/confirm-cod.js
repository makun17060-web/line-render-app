// confirm-cod.js — 代引き専用（/api/order/complete）

(async function () {

  const orderListEl = document.getElementById("orderList");
  const sumItemsEl  = document.getElementById("sumItems");
  const sumShipEl   = document.getElementById("sumShipping");
  const sumTotalEl  = document.getElementById("sumTotal");

  function yen(n){ return `${Number(n||0).toLocaleString()}円`; }

  const raw =
    sessionStorage.getItem("orderData") ||
    sessionStorage.getItem("miniappOrder") ||
    sessionStorage.getItem("currentOrder") ||
    sessionStorage.getItem("liffOrder");

  const data = JSON.parse(raw).data;
  const items = data.items || data.cart;

  let itemsTotal = 0;
  orderListEl.innerHTML = "";

  items.forEach(it => {
    const price = Number(it.price);
    const qty   = Number(it.qty);
    const row = document.createElement("div");
    row.textContent = `${it.name} × ${qty}個 = ${yen(price * qty)}`;
    orderListEl.appendChild(row);
    itemsTotal += price * qty;
  });

  // 送料（必要なら /api/shipping で計算）
  let shipping = Number(data.shipping || 0);
  if (!shipping && data.address) {
    const res = await fetch("/api/shipping", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ items, address: data.address })
    });
    const calc = await res.json();
    shipping = calc.shipping || 0;
  }

  const codFee = 330;
  const total = itemsTotal + shipping + codFee;

  sumItemsEl.textContent = yen(itemsTotal);
  sumShipEl.textContent  = yen(shipping);
  sumTotalEl.textContent = yen(total);

  // ====== 代引き注文送信 ======
  document.getElementById("confirmCod").onclick = async () => {

    const payload = {
      lineUserId: data.lineUserId,
      lineUserName: data.lineUserName,
      items,
      itemsTotal,
      shipping,
      codFee,
      finalTotal: total,
      payment: "cod",
      method: data.method || "delivery",
      address: data.address
    };

    const res = await fetch("/api/order/complete", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    const result = await res.json();
    alert("注文を受け付けました！");
    location.href = "./cod-success.html";
  };

})();
