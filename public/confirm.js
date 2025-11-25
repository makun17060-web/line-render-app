// public/confirm.js
// sessionStorage.currentOrder から items/address を読み込み、
// /api/shipping で送料計算 → /api/pay（クレジット） or /api/order/complete（代引き）

(async function () {
  const $ = (id) => document.getElementById(id);

  const itemsEl   = $("orderItems");
  const addrEl    = $("orderAddress");
  const summaryEl = $("orderSummary");
  const btnCard   = $("payByCard");
  const btnCod    = $("payByCod");
  const statusMsg = $("statusMsg");

  const COD_FEE = 330; // server.js の COD_FEE と合わせる

  function yen(n) {
    return (Number(n) || 0).toLocaleString("ja-JP") + "円";
  }

  // ====== currentOrder 読み込み ======
  let order;
  try {
    order = JSON.parse(sessionStorage.getItem("currentOrder") || "{}");
  } catch (e) {
    order = {};
  }

  if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
    itemsEl.textContent = "カート情報がありません。最初からやり直してください。";
    btnCard.disabled = true;
    btnCod.disabled  = true;
    return;
  }

  if (!order.address) {
    alert("先に住所を入力してください。");
    location.href = "/public/liff-address.html";
    return;
  }

  // ====== 送料計算 (/api/shipping) ======
  let shippingInfo;
  try {
    const body = {
      items: order.items.map(it => ({
        id: it.id,
        price: it.price,
        qty: it.qty,
      })),
      address: order.address,
    };

    const res = await fetch("/api/shipping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    shippingInfo = await res.json();
    if (!shippingInfo || !shippingInfo.ok) {
      throw new Error(shippingInfo?.error || "shipping_error");
    }
  } catch (e) {
    console.error("/api/shipping error:", e);
    statusMsg.textContent = "送料の計算に失敗しました。時間をおいてお試しください。";
    btnCard.disabled = true;
    btnCod.disabled  = true;
    return;
  }

  const itemsTotal = Number(shippingInfo.itemsTotal || 0);
  const shipping   = Number(shippingInfo.shipping   || 0);
  const region     = shippingInfo.region || "";
  const totalCard  = itemsTotal + shipping;
  const totalCod   = itemsTotal + shipping + COD_FEE;

  // ====== 表示（商品） ======
  itemsEl.textContent = order.items.map(it => {
    const sub = (Number(it.price) || 0) * (Number(it.qty) || 0);
    return `・${it.name} × ${it.qty}個 = ${yen(sub)}`;
  }).join("\n");

  // ====== 表示（住所） ======
  const addr = order.address;
  addrEl.textContent =
    `${addr.postal || ""} ${addr.prefecture || ""}${addr.city || ""}${addr.address1 || ""} ${addr.address2 || ""}\n` +
    `氏名：${addr.name || ""}\n` +
    `TEL：${addr.phone || ""}`;

  // ====== 表示（金額） ======
  summaryEl.textContent =
    `商品合計：${yen(itemsTotal)}\n` +
    `送料（${region || "未判定"}）：${yen(shipping)}\n\n` +
    `クレジット決済：${yen(totalCard)}\n` +
    `代引き：${yen(totalCod)}（代引き手数料 ${yen(COD_FEE)} 含む）`;

  // ====== クレジット決済（イプシロン） ======
  btnCard.onclick = async () => {
    statusMsg.textContent = "決済画面へ遷移します…";

    const payBody = {
      items: order.items,
      total: totalCard, // 代引き手数料なし
      lineUserId:   order.lineUserId   || "",
      lineUserName: order.lineUserName || "",
    };

    try {
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payBody),
      });
      const data = await res.json();
      if (!data.ok || !data.redirectUrl) {
        throw new Error(data.error || "pay_failed");
      }
      // イプシロンの決済画面へ
      location.href = data.redirectUrl;
    } catch (e) {
      console.error("/api/pay error:", e);
      statusMsg.textContent = "決済の開始に失敗しました。時間をおいてお試しください。";
    }
  };

  // ====== 代引きで注文確定（/api/order/complete） ======
  btnCod.onclick = async () => {
    if (!confirm("代引きで注文を確定します。よろしいですか？")) return;

    const finalTotal = totalCod;
    const payload = {
      items: order.items,
      itemsTotal,
      shipping,
      codFee: COD_FEE,
      finalTotal,
      address: order.address,
      lineUserId:   order.lineUserId   || "",
      lineUserName: order.lineUserName || "",
      payment: "cod",        // 支払い方法
      method:  "delivery",   // 受取方法（配送）
      region,
      orderNumber: String(Date.now()),
    };

    try {
      statusMsg.textContent = "注文を送信しています…";

      const res = await fetch("/api/order/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "order_failed");

      alert("代引きでのご注文を受け付けました。明細はLINEトーク画面をご確認ください。");
      sessionStorage.removeItem("currentOrder");
      location.href = "/public/products.html";
    } catch (e) {
      console.error("/api/order/complete COD error:", e);
      statusMsg.textContent = "注文の送信に失敗しました。時間をおいてお試しください。";
    }
  };

})();
