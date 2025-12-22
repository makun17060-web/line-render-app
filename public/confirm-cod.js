"use strict";

const orderListEl   = document.getElementById("orderList");
const sumItemsEl    = document.getElementById("sumItems");
const sumShippingEl = document.getElementById("sumShipping");
const sumCodEl      = document.getElementById("sumCod");
const sumTotalEl    = document.getElementById("sumTotal");
const statusMsgEl   = document.getElementById("statusMsg");

const backBtn    = document.getElementById("backBtn");
const confirmBtn = document.getElementById("confirmCod");

const COD_FEE = 330;

function yen(n) {
  return `${Number(n || 0).toLocaleString("ja-JP")}円`;
}
function setStatus(msg) {
  if (statusMsgEl) statusMsgEl.textContent = msg || "";
}
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function getOrder() {
  // liff-address.js / confirm.js が複数キーに保存している想定
  const keys = ["order", "currentOrder", "orderDraft", "confirm_normalized_order"];
  for (const k of keys) {
    const v = sessionStorage.getItem(k) || localStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (j && Array.isArray(j.items)) return j;
  }
  return { items: [], address: null };
}

function saveOrder(order) {
  // 次画面や戻った時も壊れないように複数キーへ保存
  const s = JSON.stringify(order);
  sessionStorage.setItem("order", s);
  sessionStorage.setItem("currentOrder", s);
  sessionStorage.setItem("orderDraft", s);
  sessionStorage.setItem("confirm_normalized_order", s);
  localStorage.setItem("order", s);
}

function renderItems(items) {
  if (!orderListEl) return;
  orderListEl.innerHTML = items
    .map((it) => {
      const name = it.name || it.id || "商品";
      const qty = Number(it.qty || 0);
      const sub = Number(it.price || 0) * qty;
      return `<div class="row">${name} ×${qty} = ${yen(sub)}</div>`;
    })
    .join("");
}

function normalizeItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => ({
      id: String(it.id || it.productId || ""),
      name: String(it.name || it.productName || it.id || "商品"),
      price: Number(it.price || 0),
      qty: Number(it.qty || it.quantity || 0),
    }))
    .filter((it) => it.qty > 0);
}

async function postComplete(order, paymentMethod) {
  // サーバは /api/order/complete を受けられる（あなたの server-line.js に実装済み）
  const body = {
    lineUserId: order.lineUserId || order.userId || "",
    lineUserName: order.lineUserName || "",
    items: order.items || [],
    itemsTotal: Number(order.itemsTotal || 0),
    shipping: Number(order.shippingFee ?? order.shipping ?? 0),
    codFee: paymentMethod === "cod" ? COD_FEE : 0,
    finalTotal: Number(order.finalTotal || 0),
    paymentMethod, // "cod"
    address: order.address || null,
  };

  const r = await fetch("/api/order/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(j?.error || "注文確定に失敗しました");
  return j;
}

document.addEventListener("DOMContentLoaded", async () => {
  const orderRaw = getOrder();
  const items = normalizeItems(orderRaw.items);

  if (!items.length) {
    renderItems([]);
    sumItemsEl.textContent = yen(0);
    sumShippingEl.textContent = yen(0);
    sumCodEl.textContent = yen(COD_FEE);
    sumTotalEl.textContent = yen(0);
    setStatus("カートが空です。商品一覧に戻ってください。");
    if (confirmBtn) confirmBtn.disabled = true;
    return;
  }

  renderItems(items);

  // 商品合計
  const itemsTotal =
    Number(orderRaw.itemsTotal || 0) ||
    items.reduce((s, it) => s + (Number(it.price || 0) * Number(it.qty || 0)), 0);

  // ✅ 送料（confirm.js が保存した order.shipping を拾う）
  const shipping = Number(orderRaw.shippingFee ?? orderRaw.shipping ?? 0);

  // 代引手数料
  const codFee = COD_FEE;

  // 合計
  const total = itemsTotal + shipping + codFee;

  // 画面へ反映
  if (sumItemsEl) sumItemsEl.textContent = yen(itemsTotal);
  if (sumShippingEl) sumShippingEl.textContent = yen(shipping);
  if (sumCodEl) sumCodEl.textContent = yen(codFee);
  if (sumTotalEl) sumTotalEl.textContent = yen(total);

  // 次画面/確定時のために order に確定値を保存
  const order = {
    ...orderRaw,
    items,
    itemsTotal,
    shippingFee: shipping,     // 明細ページでは shippingFee を正として持つ
    shipping,                  // 互換
    codFee,
    finalTotal: total,
    paymentMethod: "cod",
  };
  saveOrder(order);

  // ステータス（地域/サイズがあるなら出す）
  const region = orderRaw.region || "";
  const size = orderRaw.size || "";
  if (shipping > 0) {
    setStatus(region || size ? `送料：${yen(shipping)}（${region || "地域不明"} / ${size || "サイズ不明"}）` : `送料：${yen(shipping)}`);
  } else {
    setStatus("送料：0円（※住所未登録、または送料計算結果が保存されていません）");
  }

  // 戻る
  backBtn?.addEventListener("click", () => {
    location.href = "./confirm.html";
  });

  // ✅ 確定（/api/order/complete へ送る）
  confirmBtn?.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    try {
      setStatus("注文を確定しています…");
      await postComplete(order, "cod");
      setStatus("注文を確定しました。トークへ戻ります。");
      // LIFFなら closeWindow できる
      if (window.liff && typeof window.liff.closeWindow === "function") {
        try { window.liff.closeWindow(); } catch {}
      }
    } catch (e) {
      setStatus(`失敗：${e?.message || e}`);
      confirmBtn.disabled = false;
    }
  });
});
