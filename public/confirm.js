"use strict";

// ====== DOM ======
const orderListEl = document.getElementById("orderList");
const sumItemsEl = document.getElementById("sumItems");
const sumShippingEl = document.getElementById("sumShipping");
const sumTotalCodEl = document.getElementById("sumTotalCod");
const statusMsgEl = document.getElementById("statusMsg");

const cardBtn = document.getElementById("cardBtn");
const codBtn  = document.getElementById("codBtn");
const backBtn = document.getElementById("backBtn");

// ====== helpers ======
function yen(n) {
  const x = Number(n || 0);
  return `${x.toLocaleString("ja-JP")}円`;
}
function setStatus(msg) {
  if (statusMsgEl) statusMsgEl.textContent = msg || "";
}
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function getOrderFromStorage() {
  // products.js 側で複数キーに保存している想定
  const keys = ["order", "currentOrder", "orderDraft", "confirm_normalized_order"];
  for (const k of keys) {
    const v = sessionStorage.getItem(k) || localStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (j && j.items && Array.isArray(j.items)) return j;
  }
  return { items: [], itemsTotal: 0, shipping: 0, address: null };
}

function render() {
  const order = getOrderFromStorage();
  const items = Array.isArray(order.items) ? order.items : [];

  if (!items.length) {
    orderListEl.innerHTML = `<div class="order-row">カートが空です。商品一覧に戻って選択してください。</div>`;
    sumItemsEl.textContent = "0円";
    sumShippingEl.textContent = "0円";
    sumTotalCodEl.textContent = "0円";
    cardBtn.disabled = true;
    codBtn.disabled = true;
    setStatus("confirm.js は読み込まれていますが、商品が入っていません。");
    return;
  }

  const itemsTotal =
    Number(order.itemsTotal || 0) ||
    items.reduce((s, it) => s + (Number(it.price || 0) * Number(it.qty || 0)), 0);

  // 送料は別で計算して保存している場合だけ使う（なければ0表示）
  const shipping = Number(order.shipping || order.shippingFee || 0);

  // 代引き合計（代引手数料330円固定）
  const COD_FEE = 330;
  const totalCod = itemsTotal + shipping + COD_FEE;

  // 一覧
  orderListEl.innerHTML = items
    .map((it) => {
      const name = it.name || it.id || "商品";
      const qty = Number(it.qty || 0);
      const sub = Number(it.price || 0) * qty;
      return `<div class="order-row">${name} ×${qty} = ${yen(sub)}</div>`;
    })
    .join("");

  sumItemsEl.textContent = yen(itemsTotal);
  sumShippingEl.textContent = yen(shipping);
  sumTotalCodEl.textContent = yen(totalCod);

  cardBtn.disabled = false;
  codBtn.disabled = false;

  setStatus("confirm.js OK（ボタンで画面遷移できます）");
}

function go(url) {
  // LIFF内でも動くように「まず普通に遷移」→だめならopenWindow
  try {
    location.href = url;
  } catch (e) {
    // ignore
  }
  // 念のためLIFFがあれば openWindow
  if (window.liff && typeof window.liff.openWindow === "function") {
    try {
      window.liff.openWindow({ url: new URL(url, location.href).toString(), external: false });
    } catch {}
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // 念のため存在チェック
  if (!cardBtn || !codBtn) {
    setStatus("ボタン要素が見つかりません（id=cardBtn / codBtn を確認）");
    return;
  }

  render();

  // ★ここが「confirm-cod.htmlへいかない」の本丸
  cardBtn.addEventListener("click", () => go("./confirm-card.html"));
  codBtn.addEventListener("click",  () => go("./confirm-cod.html"));

  // 戻る（あなたのファイル名に合わせて必要なら変更）
  backBtn?.addEventListener("click", () => go("./address.html"));
});
