// confirm.js — ミニアプリ用「注文内容の確認」画面
// - URLクエリからカート情報を取得
// - /api/products で価格付きに変換
// - /api/shipping で送料計算
// - Stripe決済 / 代引き用の合計金額を表示

const COD_FEE = 330;

// DOM
const orderListEl   = document.getElementById("orderList");
const sumItemsEl    = document.getElementById("sumItems");
const sumShippingEl = document.getElementById("sumShipping");
const sumCodEl      = document.getElementById("sumCod");
const sumTotalEl    = document.getElementById("sumTotal");
const cardTotalEl   = document.getElementById("cardTotalText");
const statusEl      = document.getElementById("statusMsg");

const cardBtn = document.getElementById("cardBtn");
const codBtn  = document.getElementById("codBtn");
const backBtn = document.getElementById("backBtn");

function yen(n) {
  return `${Number(n || 0).toLocaleString("ja-JP")}円`;
}

function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.style.color =
    kind === "ok"  ? "#0a7b19" :
    kind === "err" ? "#d00"    :
                     "#555";
}

// ---------- カート情報の取得 ----------

// 1) ?order=JSON（以前よく作っていた形式）
// 2) ?items=kusuke-250:2,nori-square-300:1 形式
// 3) sessionStorage["isoOrder"] 形式（保険）
function loadCartFromLocation() {
  const params = new URLSearchParams(window.location.search);

  // 1) ?order={"items":[{id,qty},...]}
  const rawOrder = params.get("order");
  if (rawOrder) {
    try {
      const obj = JSON.parse(rawOrder);
      if (Array.isArray(obj.items)) {
        return obj.items
          .map(it => ({
            id: String(it.id || "").trim(),
            qty: Math.max(1, Number(it.qty || 1)),
          }))
          .filter(it => it.id);
      }
    } catch (e) {
      console.warn("parse order param error:", e);
    }
  }

  // 2) ?items=productId:qty,productId2:qty2,...
  const itemsStr = params.get("items");
  if (itemsStr) {
    const items = [];
    itemsStr.split(",").forEach(chunk => {
      const [id, q] = chunk.split(":");
      if (!id) return;
      const qty = Math.max(1, Number(q || 1));
      items.push({ id: id.trim(), qty });
    });
    if (items.length > 0) return items;
  }

  // 3) sessionStorage["isoOrder"] (保険)
  try {
    const ss = sessionStorage.getItem("isoOrder");
    if (ss) {
      const obj = JSON.parse(ss);
      if (Array.isArray(obj.items)) {
        return obj.items
          .map(it => ({
            id: String(it.id || "").trim(),
            qty: Math.max(1, Number(it.qty || 1)),
          }))
          .filter(it => it.id);
      }
    }
  } catch (e) {
    console.warn("sessionStorage isoOrder parse error:", e);
  }

  return [];
}

// ---------- 商品マスタの取得 ----------

async function fetchProductsMaster() {
  try {
    const res = await fetch("/api/products");
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error("products api error");
    // /api/products は { ok:true, products:[...] }
    return Array.isArray(data.products) ? data.products : [];
  } catch (e) {
    console.error("/api/products error:", e);
    throw e;
  }
}

// ---------- 住所の取得 ----------

async function fetchAddress() {
  try {
    const res = await fetch("/api/liff/address/me");
    const data = await res.json();
    if (data && data.ok) return data.address || null;
    return null;
  } catch (e) {
    console.warn("/api/liff/address/me error:", e);
    return null;
  }
}

// ---------- 送料計算 ----------

async function fetchShipping(items, address) {
  try {
    const res = await fetch("/api/shipping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items,
        address: address || {},
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error("shipping api error");
    return {
      itemsTotal: Number(data.itemsTotal || 0),
      shipping:   Number(data.shipping   || 0),
      region:     data.region || "",
      finalTotal: Number(data.finalTotal || 0),
    };
  } catch (e) {
    console.error("/api/shipping error:", e);
    // 計算に失敗しても商品合計だけは自前で計算しておく
    const itemsTotal = items.reduce(
      (sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0),
      0
    );
    return { itemsTotal, shipping: 0, region: "", finalTotal: itemsTotal };
  }
}

// ---------- 表示更新 ----------

function renderOrderList(detailedItems) {
  if (!detailedItems.length) {
    orderListEl.innerHTML =
      '<div class="order-row">カート内の商品が見つかりませんでした。</div>';
    return;
  }

  const rows = detailedItems.map(it => {
    const line = (Number(it.price) || 0) * (Number(it.qty) || 0);
    return `<div class="order-row">${it.name} × ${it.qty} = ${yen(line)}</div>`;
  });

  orderListEl.innerHTML = rows.join("");
}

function renderSummary(itemsTotal, shipping, codFee) {
  sumItemsEl.textContent    = yen(itemsTotal);
  sumShippingEl.textContent = yen(shipping);
  sumCodEl.textContent      = `${yen(codFee)}（代引きの場合のみ）`;

  const codTotal = itemsTotal + shipping + codFee;
  const cardTotal = itemsTotal + shipping;

  sumTotalEl.textContent   = yen(codTotal);
  cardTotalEl.textContent  = yen(cardTotal);

  return { codTotal, cardTotal };
}

// ---------- Stripe決済 ----------

async function handleCardPayment(detailedItems, itemsTotal, shipping) {
  try {
    cardBtn.disabled = true;
    codBtn.disabled  = true;
    setStatus("Stripeの決済ページに移動します…", "");

    const finalTotal = itemsTotal + shipping;
    const res = await fetch("/api/pay-stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: detailedItems,
        itemsTotal,
        shipping,
        codFee: 0,
        finalTotal,
        // lineUserId / lineUserName は省略（なくても動作）
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.checkoutUrl) {
      console.error("/api/pay-stripe error:", data);
      setStatus("決済の開始に失敗しました。時間をおいてもう一度お試しください。", "err");
      cardBtn.disabled = false;
      codBtn.disabled  = false;
      return;
    }

    // Stripe Checkout へ遷移
    window.location.href = data.checkoutUrl;
  } catch (e) {
    console.error("card payment error:", e);
    setStatus("通信エラーが発生しました。電波状況をご確認のうえ再度お試しください。", "err");
    cardBtn.disabled = false;
    codBtn.disabled  = false;
  }
}

// ---------- 代引き決済（サーバーに注文登録） ----------

async function handleCodOrder(detailedItems, itemsTotal, shipping, address) {
  try {
    cardBtn.disabled = true;
    codBtn.disabled  = true;
    setStatus("代引き注文を送信しています…", "");

    const codFee = COD_FEE;
    const finalTotal = itemsTotal + shipping + codFee;

    const res = await fetch("/api/order/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: detailedItems,
        itemsTotal,
        shipping,
        codFee,
        finalTotal,
        payment: "cod",
        address: address || null,
        // lineUserId なども省略可
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      console.error("/api/order/complete error:", data);
      setStatus("注文の登録に失敗しました。時間をおいてもう一度お試しください。", "err");
      cardBtn.disabled = false;
      codBtn.disabled  = false;
      return;
    }

    setStatus(
      "代引きでのご注文を受け付けました。\n" +
      "確認メッセージを LINE でお送りいたします。",
      "ok"
    );
  } catch (e) {
    console.error("cod order error:", e);
    setStatus("通信エラーが発生しました。電波状況をご確認のうえ再度お試しください。", "err");
    cardBtn.disabled = false;
    codBtn.disabled  = false;
  }
}

// ---------- メイン処理 ----------

window.addEventListener("DOMContentLoaded", async () => {
  try {
    setStatus("注文内容を読み込んでいます…", "");

    // 1. カート情報を取得（id, qty）
    const cartItems = loadCartFromLocation();
    if (!cartItems.length) {
      setStatus(
        "カート情報が見つかりませんでした。\n" +
        "一度、商品選択画面からやり直してください。",
        "err"
      );
      return;
    }

    // 2. 商品マスタを取得して価格付きに変換
    const products = await fetchProductsMaster();
    const detailedItems = cartItems
      .map(ci => {
        const p = products.find(x => x.id === ci.id);
        if (!p) return null;
        return {
          id:   p.id,
          name: p.name,
          price: Number(p.price) || 0,
          qty:  ci.qty,
        };
      })
      .filter(Boolean);

    if (!detailedItems.length) {
      setStatus(
        "商品マスタとの突き合わせに失敗しました。\n" +
        "商品IDがサーバーの /api/products と一致しているかご確認ください。",
        "err"
      );
      return;
    }

    // 商品一覧を表示
    renderOrderList(detailedItems);

    // 3. 保存済み住所を取得
    const address = await fetchAddress();
    if (!address) {
      setStatus(
        "お届け先住所が未登録です。\n" +
        "「住所入力（LIFF）」画面から住所を登録してください。",
        ""
      );
    }

    // 4. 送料計算 (/api/shipping)
    const ship = await fetchShipping(detailedItems, address);
    const { codTotal, cardTotal } = renderSummary(
      ship.itemsTotal,
      ship.shipping,
      COD_FEE
    );

    if (ship.region) {
      setStatus(
        `配送地域：${ship.region}\n` +
        `カード決済：${yen(cardTotal)} / 代引き：${yen(codTotal)}`,
        "ok"
      );
    } else {
      setStatus(
        "配送地域が判定できませんでした。\n" +
        "住所（都道府県・市区町村）が正しく入力されているかご確認ください。",
        ""
      );
    }

    // 5. ボタン動作を登録
    cardBtn.addEventListener("click", () =>
      handleCardPayment(detailedItems, ship.itemsTotal, ship.shipping)
    );

    codBtn.addEventListener("click", () =>
      handleCodOrder(detailedItems, ship.itemsTotal, ship.shipping, address)
    );

    backBtn.addEventListener("click", () => {
      history.back();
    });
  } catch (e) {
    console.error("confirm.js init error:", e);
    setStatus("初期化中にエラーが発生しました。時間をおいて再度お試しください。", "err");
  }
});
