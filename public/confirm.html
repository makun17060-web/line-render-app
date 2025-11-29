// /public/confirm.js — 代引き専用版（送料自動計算付き）
// - 決済会社は使わず、/api/order/complete に直接送信
// - shipping が未設定のときは /api/shipping で自動計算
// - 商品合計 + 送料 + 代引き手数料 を画面表示

(function () {
  "use strict";

  const orderListEl = document.getElementById("orderList");
  const sumItemsEl  = document.getElementById("sumItems");
  const sumShipEl   = document.getElementById("sumShipping");
  const sumCodEl    = document.getElementById("sumCod");
  const sumTotalEl  = document.getElementById("sumTotal");

  const confirmBtn  = document.getElementById("confirmBtn");
  const backBtn     = document.getElementById("backBtn");
  const statusMsgEl = document.getElementById("statusMsg");

  // どのキーに注文データが保存されているか分からないので、よくありそうなキーを総当り
  const STORAGE_KEYS = [
    "codOrder",      // 代引き用に自分で set するならこれ推奨
    "orderData",
    "miniappOrder",
    "currentOrder",
    "liffOrder"
  ];

  function setStatus(msg) {
    if (!statusMsgEl) return;
    statusMsgEl.textContent = msg || "";
  }

  function yen(n) {
    return `${Number(n || 0).toLocaleString("ja-JP")}円`;
  }

  // ---- 注文データを sessionStorage / localStorage から読む ----
  function loadRawData() {
    for (const key of STORAGE_KEYS) {
      try {
        const raw =
          sessionStorage.getItem(key) ||
          localStorage.getItem(key);
        if (!raw) continue;

        const data = JSON.parse(raw);
        if (!data) continue;

        console.log("confirm-cod.js: 読み込んだ注文データキー:", key, data);
        return { key, data };
      } catch (e) {
        console.warn("confirm-cod.js: JSON parse 失敗", e);
      }
    }
    return null;
  }

  // ---- いろんな形のデータを正規化する ----
  function normalizeOrder(raw) {
    if (!raw) return null;

    // raw.data や raw.order に入っている場合も想定
    const src = raw.data || raw.order || raw;

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

      const price =
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

      if (!qty || price < 0) continue;

      items.push({ id, name, price, qty });
      calcItemsTotal += price * qty;
    }

    if (!items.length) return null;

    const itemsTotal =
      Number(src.itemsTotal || src.totalAmount || src.total || 0) || calcItemsTotal;

    const shipping = Number(src.shipping || 0) || 0;

    // codFee が未指定なら 330円 をデフォルトにしておく
    let codFee = Number(src.codFee || 0);
    if (!codFee) {
      // src.payment が "cod" のときだけデフォルト 330 を当ててもOK
      if (!src.payment || src.payment === "cod") {
        codFee = 330;
      }
    }

    const finalTotal =
      Number(src.finalTotal || 0) || (itemsTotal + shipping + codFee);

    const address = src.address || null;
    const lineUserId   = src.lineUserId   || src.userId   || "";
    const lineUserName = src.lineUserName || src.userName || "";
    const method  = src.method  || "delivery"; // 店頭受け取りなら "pickup" など
    const payment = "cod";

    return {
      items,
      itemsTotal,
      shipping,
      codFee,
      finalTotal,
      address,
      lineUserId,
      lineUserName,
      method,
      payment,
    };
  }

  let order = null;

  // ---- shipping 未設定なら /api/shipping で送料を計算 ----
  async function applyShippingIfNeeded(nd) {
    // 店頭受け取りのときは送料 0 のままで良い
    if (!nd || nd.method === "pickup") return nd;

    if ((nd.shipping && nd.shipping > 0) || !nd.address) {
      // 既に送料が入っている or 住所が無い → 触らない
      return nd;
    }

    try {
      const res = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: nd.items.map(it => ({
            id: it.id,
            price: it.price,
            qty: it.qty,
          })),
          address: nd.address,
        }),
      });

      if (!res.ok) {
        console.warn("api/shipping HTTP error:", res.status);
        return nd;
      }

      const data = await res.json();
      console.log("api/shipping result:", data);

      if (!data || !data.ok) return nd;

      const itemsTotal = Number(data.itemsTotal || nd.itemsTotal || 0);
      const shipping   = Number(data.shipping   || 0);
      const finalTotal =
        Number(data.finalTotal || 0) || (itemsTotal + shipping + nd.codFee);

      return {
        ...nd,
        itemsTotal,
        shipping,
        finalTotal,
      };
    } catch (e) {
      console.error("applyShippingIfNeeded error:", e);
      return nd;
    }
  }

  async function initOrder() {
    const raw = loadRawData();
    if (!raw) {
      showNoOrder();
      return;
    }

    let normalized = normalizeOrder(raw);
    if (!normalized || !normalized.items.length) {
      showNoOrder();
      return;
    }

    // ★ 送料が入っていなければ /api/shipping で自動計算
    normalized = await applyShippingIfNeeded(normalized);

    order = normalized;
    renderOrder();
  }

  function showNoOrder() {
    if (orderListEl) {
      orderListEl.innerHTML =
        "<p>商品内容が確認できません。<br>商品一覧に戻って、もう一度やり直してください。</p>";
    }
    if (confirmBtn) confirmBtn.disabled = true;
    if (sumItemsEl)  sumItemsEl.textContent  = "0円";
    if (sumShipEl)   sumShipEl.textContent   = "0円";
    if (sumCodEl)    sumCodEl.textContent    = "0円";
    if (sumTotalEl)  sumTotalEl.textContent  = "0円";
  }

  // ---- 画面に注文内容を表示 ----
  function renderOrder() {
    if (!order || !order.items || !order.items.length) {
      showNoOrder();
      return;
    }

    if (orderListEl) {
      orderListEl.innerHTML = "";
      order.items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "order-row";
        const unit = Number(item.price || 0);
        const qty  = Number(item.qty   || item.quantity || 0);
        const lineTotal = unit * qty;

        row.textContent =
          `${item.name || "商品"} × ${qty}個 （${yen(unit)}／個 = ${yen(lineTotal)}）`;
        orderListEl.appendChild(row);
      });
    }

    if (sumItemsEl) {
      sumItemsEl.textContent = yen(order.itemsTotal);
    }
    if (sumShipEl) {
      sumShipEl.textContent = yen(order.shipping);
    }
    if (sumCodEl) {
      sumCodEl.textContent = yen(order.codFee);
    }
    if (sumTotalEl) {
      sumTotalEl.textContent = yen(order.finalTotal);
    }
  }

  // ---- 代引き注文をサーバーに送信 ----
  async function submitCodOrder() {
    if (!order || !order.items || !order.items.length) {
      alert("注文内容がありません。商品一覧からやり直してください。");
      return;
    }

    // 念のため送信前にも送料が無ければ計算
    order = await applyShippingIfNeeded(order);

    const payload = {
      lineUserId:   order.lineUserId   || "",
      lineUserName: order.lineUserName || "",
      items:        order.items.map(it => ({
        id:   it.id,
        name: it.name || "商品",
        price: Number(it.price || 0),
        qty:   Number(it.qty   || 0),
      })),
      itemsTotal: order.itemsTotal,
      shipping:   order.shipping,
      codFee:     order.codFee,
      finalTotal: order.finalTotal,
      address:    order.address || null,
      payment:    order.payment || "cod",
      method:     order.method  || "delivery",
    };

    try {
      setStatus("ご注文内容を送信しています…");
      if (confirmBtn) confirmBtn.disabled = true;

      const res = await fetch("/api/order/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      let data = null;
      try {
        data = await res.json();
      } catch (_) {}

      if (res.ok && data && data.ok) {
        setStatus("ご注文を受け付けました。\nLINEのトーク画面に明細が届きます。");
      } else {
        console.error("order/complete error:", data);
        alert("ご注文の送信に失敗しました。時間をおいてもう一度お試しください。");
        setStatus("ご注文の送信に失敗しました。");
        if (confirmBtn) confirmBtn.disabled = false;
      }
    } catch (e) {
      console.error("submitCodOrder exception:", e);
      alert("通信エラーが発生しました。時間をおいてもう一度お試しください。");
      setStatus("通信エラーが発生しました。");
      if (confirmBtn) confirmBtn.disabled = false;
    }

    // 画面にも最新の合計を反映
    renderOrder();
  }

  // ---- イベントハンドラ ----
  if (confirmBtn) {
    confirmBtn.addEventListener("click", function (ev) {
      ev.preventDefault();
      submitCodOrder();
    });
  }

  if (backBtn) {
    backBtn.addEventListener("click", function (ev) {
      ev.preventDefault();
      history.back();
    });
  }

  // 初期化（async）
  (async () => {
    await initOrder();
  })();
})();
