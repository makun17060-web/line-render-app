// /public/confirm-cod.js — 代引き専用
// ・いろいろな形式の注文データから商品金額を取得
// ・送料が無ければ /api/shipping で自動計算
// ・/api/order/complete に投げて管理者＆注文者へ通知

(function () {
  "use strict";

  const orderListEl = document.getElementById("orderList");
  const sumItemsEl  = document.getElementById("sumItems");
  const sumShipEl   = document.getElementById("sumShipping");
  const sumCodEl    = document.getElementById("sumCod");
  const sumTotalEl  = document.getElementById("sumTotal");
  const btnCod      = document.getElementById("confirmCod");
  const statusMsgEl = document.getElementById("statusMsg");

  const DEFAULT_COD_FEE = 330;

  function yen(n) {
    return `${Number(n || 0).toLocaleString("ja-JP")}円`;
  }

  function setStatus(msg) {
    if (!statusMsgEl) return;
    statusMsgEl.textContent = msg || "";
  }

  // ---- ストレージから生データを読む（キーは全部試す） ----
  function loadRawData() {
    const keys = [
      "orderData",
      "miniappOrder",
      "currentOrder",
      "liffOrder",
      "codOrder",
    ];
    for (const key of keys) {
      try {
        const raw =
          sessionStorage.getItem(key) ||
          localStorage.getItem(key);
        if (!raw) continue;
        const data = JSON.parse(raw);
        console.log("confirm-cod: 読み込んだキー:", key, data);
        return data;
      } catch (e) {
        console.warn("confirm-cod: JSON parse 失敗", e);
      }
    }
    return null;
  }

  // ---- いろんな形のデータを正規化する ----
  function normalizeOrder(raw) {
    if (!raw) return null;

    // { data: {...} } / { order: {...} } / それ以外 のどれでも対応
    const src = raw.data || raw.order || raw;

    // items / cart どちらにも対応
    let itemsSrc =
      Array.isArray(src.items) ? src.items :
      Array.isArray(src.cart)  ? src.cart  :
      null;

    if (!itemsSrc || !itemsSrc.length) return null;

    const items = [];
    let calcItemsTotal = 0;

    for (const it of itemsSrc) {
      if (!it) continue;

      const id =
        it.id ||
        it.productId ||
        it.code ||
        "";

      const name =
        it.name ||
        it.productName ||
        "商品";

      const unitPrice =
        Number(
          it.price ||
          it.unitPrice ||
          it.unit_price ||
          it.unit ||
          0
        ) || 0;

      const qty =
        Number(
          it.qty ||
          it.quantity ||
          it.count ||
          it.num ||
          0
        ) || 0;

      if (!qty || unitPrice < 0) continue;

      items.push({ id, name, price: unitPrice, qty });
      calcItemsTotal += unitPrice * qty;
    }

    if (!items.length) return null;

    const itemsTotal =
      Number(src.itemsTotal || src.totalAmount || src.total || 0) || calcItemsTotal;

    const shipping = Number(src.shipping || 0) || 0;

    let codFee = Number(src.codFee || 0);
    if (!codFee || codFee <= 0) codFee = DEFAULT_COD_FEE;

    const address      = src.address || null;
    const lineUserId   = src.lineUserId   || src.userId   || "";
    const lineUserName = src.lineUserName || src.userName || "";
    const method       = src.method       || "delivery";

    const totalCod = itemsTotal + shipping + codFee;

    return {
      items,
      itemsTotal,
      shipping,
      codFee,
      totalCod,
      address,
      lineUserId,
      lineUserName,
      method,
    };
  }

  // ---- 送料が無ければ /api/shipping で計算 ----
  async function applyShippingIfNeeded(order) {
    if (!order) return order;
    // 店頭受け取りは送料 0 のままでOK
    if (order.method === "pickup") return order;

    if ((order.shipping && order.shipping > 0) || !order.address) {
      return order;
    }

    try {
      const res = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: order.items.map(it => ({
            id: it.id,
            price: it.price,
            qty: it.qty,
          })),
          address: order.address,
        }),
      });
      if (!res.ok) {
        console.warn("api/shipping HTTP error:", res.status);
        return order;
      }
      const data = await res.json();
      console.log("api/shipping result:", data);

      if (!data || !data.ok) return order;

      const itemsTotal = Number(data.itemsTotal || order.itemsTotal || 0);
      const shipping   = Number(data.shipping   || 0);
      const totalCod   = itemsTotal + shipping + order.codFee;

      return {
        ...order,
        itemsTotal,
        shipping,
        totalCod,
      };
    } catch (e) {
      console.error("applyShippingIfNeeded error:", e);
      return order;
    }
  }

  let order = null;

  // ---- 初期化 ----
  async function init() {
    const raw = loadRawData();
    if (!raw) {
      if (orderListEl) {
        orderListEl.innerHTML =
          "<p>注文情報が見つかりません。商品一覧からやり直してください。</p>";
      }
      if (btnCod) btnCod.disabled = true;
      return;
    }

    let normalized = normalizeOrder(raw);
    if (!normalized || !normalized.items.length) {
      if (orderListEl) {
        orderListEl.innerHTML =
          "<p>注文情報が見つかりません。商品一覧からやり直してください。</p>";
      }
      if (btnCod) btnCod.disabled = true;
      return;
    }

    // 送料が無ければサーバーで計算
    normalized = await applyShippingIfNeeded(normalized);
    order = normalized;

    render();
  }

  // ---- 画面に反映 ----
  function render() {
    if (!order || !order.items || !order.items.length) return;

    const itemsTotal = Number(order.itemsTotal || 0);
    const shipping   = Number(order.shipping   || 0);
    const codFee     = Number(order.codFee     || DEFAULT_COD_FEE);
    const totalCod   = itemsTotal + shipping + codFee;
    order.totalCod   = totalCod;

    if (orderListEl) {
      orderListEl.innerHTML = "";
      order.items.forEach(it => {
        const row = document.createElement("div");
        row.className = "row";
        row.textContent =
          `${it.name} × ${it.qty}個 = ${yen(it.price * it.qty)}`;
        orderListEl.appendChild(row);
      });
    }

    if (sumItemsEl)  sumItemsEl.textContent  = yen(itemsTotal);
    if (sumShipEl)   sumShipEl.textContent   = yen(shipping);
    if (sumCodEl)    sumCodEl.textContent    = yen(codFee);
    if (sumTotalEl)  sumTotalEl.textContent  = yen(totalCod);
  }

  // ---- 代引き注文をサーバーへ送信 ----
  async function submitCodOrder() {
    if (!order || !order.items || !order.items.length) {
      alert("注文内容がありません。商品一覧からやり直してください。");
      return;
    }

    // 念のため送料を最新に
    order = await applyShippingIfNeeded(order);
    render();

    const itemsTotal = Number(order.itemsTotal || 0);
    const shipping   = Number(order.shipping   || 0);
    const codFee     = Number(order.codFee     || DEFAULT_COD_FEE);
    const finalTotal = itemsTotal + shipping + codFee;

    const payload = {
      lineUserId:   order.lineUserId   || "",
      lineUserName: order.lineUserName || "",
      items: order.items.map(it => ({
        id:   it.id,
        name: it.name || "商品",
        price: Number(it.price || 0),
        qty:   Number(it.qty   || 0),
      })),
      itemsTotal,
      shipping,
      codFee,
      finalTotal,
      address: order.address || null,
      payment: "cod",
      method:  order.method || "delivery",
    };

    try {
      setStatus("代引き注文を送信しています…");
      if (btnCod) btnCod.disabled = true;

      const res = await fetch("/api/order/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      let data = null;
      try { data = await res.json(); } catch (_) {}

      if (res.ok && data && data.ok) {
        setStatus("ご注文を受け付けました。LINEのトークに明細が届きます。");
        // 既存の成功ページを使う
        location.href = "./confirm-cod-success.html";
      } else {
        console.error("order/complete error:", data);
        alert("ご注文の送信に失敗しました。時間をおいてもう一度お試しください。");
        setStatus("ご注文の送信に失敗しました。");
        if (btnCod) btnCod.disabled = false;
      }
    } catch (e) {
      console.error("submitCodOrder error:", e);
      alert("通信エラーが発生しました。時間をおいてもう一度お試しください。");
      setStatus("通信エラーが発生しました。");
      if (btnCod) btnCod.disabled = false;
    }
  }

  if (btnCod) {
    btnCod.addEventListener("click", function (ev) {
      ev.preventDefault();
      submitCodOrder();
    });
  }

  (async () => {
    await init();
  })();
})();
