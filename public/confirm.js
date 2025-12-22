"use strict";

const orderListEl = document.getElementById("orderList");
const sumItemsEl = document.getElementById("sumItems");
const sumShippingEl = document.getElementById("sumShipping");
const sumTotalCodEl = document.getElementById("sumTotalCod");
const statusMsgEl = document.getElementById("statusMsg");

const cardBtn = document.getElementById("cardBtn");
const codBtn  = document.getElementById("codBtn");
const backBtn = document.getElementById("backBtn");

const COD_FEE = 330;

function yen(n) {
  const x = Number(n || 0);
  return `${x.toLocaleString("ja-JP")}円`;
}
function setStatus(msg) {
  if (statusMsgEl) statusMsgEl.textContent = msg || "";
}
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function getOrder() {
  const keys = ["order", "currentOrder", "orderDraft", "confirm_normalized_order"];
  for (const k of keys) {
    const v = sessionStorage.getItem(k) || localStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (j && j.items && Array.isArray(j.items)) return j;
  }
  return { items: [], itemsTotal: 0, address: null };
}

function saveOrder(order) {
  // confirm / 次画面で必ず拾えるように複数キーに保存
  sessionStorage.setItem("order", JSON.stringify(order));
  sessionStorage.setItem("currentOrder", JSON.stringify(order));
  sessionStorage.setItem("orderDraft", JSON.stringify(order));
  sessionStorage.setItem("confirm_normalized_order", JSON.stringify(order));
  localStorage.setItem("order", JSON.stringify(order));
}

function hasAddress(a) {
  if (!a) return false;
  const pref = a.prefecture || a.pref || "";
  const city = a.city || "";
  const addr1 = a.address1 || a.addr1 || "";
  return String(pref).trim() && String(city).trim() && String(addr1).trim();
}

async function calcShipping(items, address) {
  const body = { items, address };
  const r = await fetch("/api/shipping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(j?.error || "shipping_error");
  return j; // {itemsTotal, region, size, shipping, finalTotal}
}

function renderItems(items) {
  orderListEl.innerHTML = items
    .map((it) => {
      const name = it.name || it.id || "商品";
      const qty = Number(it.qty || 0);
      const sub = Number(it.price || 0) * qty;
      return `<div class="order-row">${name} ×${qty} = ${yen(sub)}</div>`;
    })
    .join("");
}

function go(url) {
  try { location.href = url; } catch {}
  if (window.liff && typeof window.liff.openWindow === "function") {
    try { window.liff.openWindow({ url: new URL(url, location.href).toString(), external: false }); } catch {}
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const order = getOrder();
  const items = Array.isArray(order.items) ? order.items : [];

  if (!items.length) {
    orderListEl.innerHTML = `<div class="order-row">カートが空です。商品一覧に戻ってください。</div>`;
    sumItemsEl.textContent = "0円";
    sumShippingEl.textContent = "0円";
    sumTotalCodEl.textContent = "0円";
    cardBtn.disabled = true;
    codBtn.disabled = true;
    setStatus("商品が入っていません。");
    return;
  }

  // 商品合計（まず表示）
  const itemsTotal =
    Number(order.itemsTotal || 0) ||
    items.reduce((s, it) => s + (Number(it.price || 0) * Number(it.qty || 0)), 0);

  renderItems(items);
  sumItemsEl.textContent = yen(itemsTotal);

  // 送料を計算して反映
  try {
    setStatus("送料を計算しています…");

    const address = order.address || null;

    if (!hasAddress(address)) {
      // 住所が order に入っていない
      sumShippingEl.textContent = "0円（住所未登録）";
      sumTotalCodEl.textContent = yen(itemsTotal + COD_FEE);
      setStatus("住所が未登録のため、送料を計算できません。住所入力へ戻って保存してください。");

      // 住所入力に戻すボタン（任意）
      // backBtn は address.html に戻る想定
    } else {
      const result = await calcShipping(items, address);
      const shipping = Number(result.shipping || 0);

      // order に送料情報も保存（次画面へ渡す）
      order.itemsTotal = Number(result.itemsTotal || itemsTotal);
      order.shipping = shipping;
      order.region = result.region || "";
      order.size = result.size || "";
      saveOrder(order);

      sumShippingEl.textContent = yen(shipping);
      sumTotalCodEl.textContent = yen(Number(result.itemsTotal || itemsTotal) + shipping + COD_FEE);
      setStatus(`送料OK（地域：${order.region || "不明"} / サイズ：${order.size || "?"}）`);
    }
  } catch (e) {
    sumShippingEl.textContent = "0円（計算エラー）";
    sumTotalCodEl.textContent = yen(itemsTotal + COD_FEE);
    setStatus(`送料計算に失敗しました：${e?.message || e}`);
  }

  // ボタン遷移
  cardBtn.disabled = false;
  codBtn.disabled = false;

  cardBtn.addEventListener("click", () => go("./confirm-card.html"));
  codBtn.addEventListener("click",  () => go("./confirm-cod.html"));
  backBtn?.addEventListener("click", () => go("./address.html"));
});
