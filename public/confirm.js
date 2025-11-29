// /public/confirm.js — クレジット（Stripe）＋代引き 両対応版
// ・/api/pay-stripe でカード決済へ
// ・/api/order/complete で代引き注文を直接登録
// ・送料が無ければ /api/shipping で自動計算

(function () {
  "use strict";

  const orderListEl = document.getElementById("orderList");
  const sumItemsEl  = document.getElementById("sumItems");
  const sumShipEl   = document.getElementById("sumShipping");
  const sumCodEl    = document.getElementById("sumCod");
  const sumTotalEl  = document.getElementById("sumTotal");      // 代引き合計
  const cardTotalEl = document.getElementById("cardTotalText"); // カード合計

  const cardBtn     = document.getElementById("cardBtn");
  const codBtn      = document.getElementById("codBtn");
  const backBtn     = document.getElementById("backBtn");
  const statusMsgEl = document.getElementById("statusMsg");

  // どのキーに注文データが入っているか分からないので候補を総当り
  const STORAGE_KEYS = [
    "orderData",
    "miniappOrder",
    "currentOrder",
    "liffOrder",
    "codOrder"        // 代引き専用で保存している場合も拾う
  ];

  const DEFAULT_COD_FEE = 330;

  function setStatus(msg) {
    if (!statusMsgEl) return;
    statusMsgEl.textContent = msg || "";
  }

  function yen(n) {
    return `${Number(n || 0).toLocaleString("ja-JP")}円`;
  }

  // ---- ストレージから元データを読む ----
  function loadRawData() {
    for (const key of STORAGE_KEYS) {
      try {
        const raw =
          sessionStorage.getItem(key) ||
          localStorage.getItem(key);
        if (!raw) continue;

        const data = JSON.parse(raw);
        if (!data) continue;

        console.log("confirm.js: 読み込んだ注文データキー:", key, data);
        return { key, data };
      } catch (e) {
        console.warn("confirm.js: JSON parse 失敗", e);
      }
    }
    return null;
  }

  // ---- いろんな形のデータを正規化 ----
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

    // 代引き手数料。未指定なら 330円
    let codFee = Number(src.codFee || 0);
    if (!codFee) {
      codFee = DEFAULT_COD_FEE;
    }

    const address = src.address || null;
    const lineUserId   = src.lineUserId   || src.userId   || "";
    const lineUserName = src.lineUserName || src.userName || "";
    const method  = src.method  || "delivery"; // pickup の場合もあり
    // src.payment を見ていたとしても、この画面では「両方ボタンを出す」想定にします

    // ここでは「代引き合計」を計算
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

  let order = null;

  // ---- shipping 未設定なら /api/shipping で送料を自動計算 ----
  async function applyShippingIfNeeded(nd) {
    if (!nd) return nd;
    // 店頭受け取りのときは送料 0 のままでOK
    if (nd.method === "pickup") return nd;

    // すでに送料が入っている or 住所が無ければ何もしない
    if ((nd.shipping && nd.shipping > 0) || !nd.address) return nd;

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
      const totalCod   = itemsTotal + shipping + nd.codFee;

      return {
        ...nd,
        itemsTotal,
        shipping,
        totalCod,
      };
    } catch (e) {
      console.error("applyShippingIfNeeded error:", e);
      return nd;
    }
  }

  // ---- 初期化 ----
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

    // ★ 送料が無ければ /api/shipping で計算
    normalized = await applyShippingIfNeeded(normalized);

    order = normalized;
    renderOrder();
  }

  function showNoOrder() {
    if (orderListEl) {
      orderListEl.innerHTML =
        "<p>商品内容が確認できません。<br>商品一覧に戻って、もう一度やり直してください。</p>";
    }
    if (cardBtn) cardBtn.disabled = true;
    if (codBtn)  codBtn.disabled  = true;
    if (sumItemsEl)  sumItemsEl.textContent  = "0円";
    if (sumShipEl)   sumShipEl.textContent   = "0円";
    if (sumCodEl)    sumCodEl.textContent    = "330円（代引きの場合のみ）";
    if (sumTotalEl)  sumTotalEl.textContent  = "0円";
    if (cardTotalEl) cardTotalEl.textContent = "0円";
  }

  // ---- 画面描画 ----
  function renderOrder() {
    if (!order || !order.items || !order.items.length) {
      showNoOrder();
      return;
    }

    const itemsTotal = Number(order.itemsTotal || 0);
    const shipping   = Number(order.shipping   || 0);
    const codFee     = Number(order.codFee     || DEFAULT_COD_FEE);
    const totalCod   = itemsTotal + shipping + codFee;
    order.totalCod   = totalCod; // 念のため上書き

    const totalCard  = itemsTotal + shipping;

    // 商品一覧
    if (orderListEl) {
      orderListEl.innerHTML = "";
      order.items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "order-row";
        const unit = Number(item.price || 0);
        const qty  = Number(item.qty   || 0);
        const lineTotal = unit * qty;

        row.textContent =
          `${item.name || "商品"} × ${qty}個 （${yen(unit)}／個 = ${yen(lineTotal)}）`;
        orderListEl.appendChild(row);
      });
    }

    if (sumItemsEl) {
      sumItemsEl.textContent = yen(itemsTotal);
    }
    if (sumShipEl) {
      sumShipEl.textContent = yen(shipping);
    }
    if (sumCodEl) {
      sumCodEl.textContent = `${yen(codFee)}（代引きの場合のみ）`;
    }
    if (sumTotalEl) {
      sumTotalEl.textContent = yen(totalCod);
    }
    if (cardTotalEl) {
      cardTotalEl.textContent = yen(totalCard);
    }
  }

  // ---- クレジットカード（Stripe Checkout） ----
  async function startStripeCheckout() {
    if (!order || !order.items || !order.items.length) {
      alert("注文内容がありません。商品一覧からやり直してください。");
      return;
    }

    // 念のため最新送料を反映
    order = await applyShippingIfNeeded(order);
    renderOrder();

    const itemsForApi = order.items.map((it) => ({
      id:   it.id,
      name: it.name || "商品",
      price: Number(it.price || 0),
      qty:   Number(it.qty   || 1),
    }));

    const itemsTotal = Number(order.itemsTotal || 0);
    const shipping   = Number(order.shipping   || 0);
    const codFee     = 0; // カード決済なので代引き手数料なし
    const finalTotal = itemsTotal + shipping + codFee;

    const payload = {
      lineUserId:   order.lineUserId   || "",
      lineUserName: order.lineUserName || "",
      items:       itemsForApi,
      itemsTotal,
      shipping,
      codFee,
      finalTotal,
      address: order.address || null,
      payment: "card",
      method:  order.method || "delivery",
    };

    if (!payload.items.length || !payload.itemsTotal) {
      alert("注文データに不備があります。商品一覧からやり直してください。");
      return;
    }

    try {
      setStatus("クレジット決済を開始しています…");
      if (cardBtn) cardBtn.disabled = true;
      if (codBtn)  codBtn.disabled  = true;

      // 成功画面から /api/order/complete を呼ぶために保存
      localStorage.setItem("lastStripeOrder", JSON.stringify(payload));

      const res = await fetch("/api/pay-stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        console.error("決済APIエラー HTTP:", res.status);
        alert("決済の開始に失敗しました。時間をおいてもう一度お試しください。");
        setStatus("");
        if (cardBtn) cardBtn.disabled = false;
        if (codBtn)  codBtn.disabled  = false;
        return;
      }

      const data = await res.json();
      console.log("Stripe /api/pay-stripe レスポンス:", data);

      if (!data || !data.ok || !data.checkoutUrl) {
        alert("決済の開始に失敗しました。時間をおいてもう一度お試しください。");
        setStatus("");
        if (cardBtn) cardBtn.disabled = false;
        if (codBtn)  codBtn.disabled  = false;
        return;
      }

      // Stripe Checkout へ遷移
      location.href = data.checkoutUrl;
    } catch (e) {
      console.error("決済開始時の例外:", e);
      alert("通信エラーが発生しました。時間をおいてもう一度お試しください。");
      setStatus("");
      if (cardBtn) cardBtn.disabled = false;
      if (codBtn)  codBtn.disabled  = false;
    }
  }

  // ---- 代引き注文をサーバーへ送信 ----
  async function submitCodOrder() {
    if (!order || !order.items || !order.items.length) {
      alert("注文内容がありません。商品一覧からやり直してください。");
      return;
    }

    // 念のため送料を最新に
    order = await applyShippingIfNeeded(order);
    renderOrder();

    const itemsTotal = Number(order.itemsTotal || 0);
    const shipping   = Number(order.shipping   || 0);
    const codFee     = Number(order.codFee     || DEFAULT_COD_FEE);
    const finalTotal = itemsTotal + shipping + codFee;

    const payload = {
      lineUserId:   order.lineUserId   || "",
      lineUserName: order.lineUserName || "",
      items:        order.items.map(it => ({
        id:   it.id,
        name: it.name || "商品",
        price: Number(it.price || 0),
        qty:   Number(it.qty   || 0),
      })),
      itemsTotal,
      shipping,
      codFee,
      finalTotal,
      address:    order.address || null,
      payment:    "cod",
      method:     order.method || "delivery",
    };

    try {
      setStatus("代引き注文を送信しています…");
      if (cardBtn) cardBtn.disabled = true;
      if (codBtn)  codBtn.disabled  = true;

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
        if (cardBtn) cardBtn.disabled = false;
        if (codBtn)  codBtn.disabled  = false;
      }
    } catch (e) {
      console.error("submitCodOrder exception:", e);
      alert("通信エラーが発生しました。時間をおいてもう一度お試しください。");
      setStatus("通信エラーが発生しました。");
      if (cardBtn) cardBtn.disabled = false;
      if (codBtn)  codBtn.disabled  = false;
    }
  }

  // ---- ボタンイベント ----
  if (cardBtn) {
    cardBtn.addEventListener("click", function (ev) {
      ev.preventDefault();
      startStripeCheckout();
    });
  }

  if (codBtn) {
    codBtn.addEventListener("click", function (ev) {
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

  // ---- 初期化実行 ----
  (async () => {
    await initOrder();
  })();
})();
