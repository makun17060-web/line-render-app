"use strict";

/**
 * confirm.js — 注文内容の確認・支払方法の選択
 *
 * ✅ 修正ポイント（送料が反映されない対策）
 * - order を複数キーから確実に読む（order/currentOrder/orderDraft/confirm_normalized_order + localStorage）
 * - order.shipping が無ければ /api/shipping で再計算して保存
 * - 住所の pref キーゆらぎ（prefecture / pref）にも対応
 * - 表示（sumShipping / sumTotalCod 等）を必ず更新
 */

// ====== DOM ======
const orderList = document.getElementById("orderList");
const sumItemsEl = document.getElementById("sumItems");
const sumShippingEl = document.getElementById("sumShipping");
const sumTotalCodEl = document.getElementById("sumTotalCod");
const statusMsg = document.getElementById("statusMsg");

const cardBtn = document.getElementById("cardBtn");
const codBtn = document.getElementById("codBtn");
const backBtn = document.getElementById("backBtn");

// ====== 設定 ======
// ★あなたの明細ページのファイル名に合わせて変更
const CARD_DETAIL_PAGE = "./card.html"; // 例：./card-detail.html など
const COD_DETAIL_PAGE  = "./cod.html";  // 例：./cod-detail.html など
const ADDRESS_PAGE     = "./liff-address.html";

// 代引き手数料（表示と計算用）
const COD_FEE = 330;

// products.js / liff-address.js と揃える
const ORDER_KEYS = ["order", "currentOrder", "orderDraft", "confirm_normalized_order"];

// ====== Utils ======
function setStatus(msg = "") {
  if (statusMsg) statusMsg.textContent = msg;
}
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
function toNum(x, fallback = 0) {
  const n = Number(String(x ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : fallback;
}
function yen(n) {
  return `${toNum(n, 0).toLocaleString("ja-JP")}円`;
}

function loadOrder() {
  // sessionStorage 優先
  for (const k of ORDER_KEYS) {
    const v = sessionStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (j && typeof j === "object") return j;
  }
  // localStorage フォールバック
  const v2 = localStorage.getItem("order");
  const j2 = v2 ? safeJsonParse(v2) : null;
  if (j2 && typeof j2 === "object") return j2;

  return { items: [], itemsTotal: 0, address: null };
}

function saveOrderAll(order) {
  const txt = JSON.stringify(order);
  for (const k of ORDER_KEYS) sessionStorage.setItem(k, txt);
  localStorage.setItem("order", txt);
}

function normalizeItems(order) {
  const arr = Array.isArray(order?.items) ? order.items : [];
  return arr.map((it) => ({
    id: String(it.id ?? it.productId ?? "").trim(),
    name: String(it.name ?? "").trim(),
    qty: toNum(it.qty ?? it.quantity ?? 0, 0),
    price: toNum(it.price ?? 0, 0),
    volume: String(it.volume ?? ""),
  })).filter((it) => it.id && it.qty > 0);
}

function normalizePrefecture(order) {
  const a = order?.address || {};
  // キー揺れ対応
  return String(a.prefecture || a.pref || "").trim();
}

function renderOrderList(items) {
  if (!orderList) return;
  if (!items.length) {
    orderList.innerHTML = `<div class="order-row">商品が選択されていません。</div>`;
    return;
  }

  const rows = items.map((it) => {
    const sub = it.price * it.qty;
    const vol = it.volume ? `（${it.volume}）` : "";
    return `<div class="order-row">${escapeHtml(it.name)}${escapeHtml(vol)} ×${it.qty} ＝ ${yen(sub)}</div>`;
  });
  orderList.innerHTML = rows.join("");
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function calcShippingByApi(items, prefecture) {
  const r = await fetch("/api/shipping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items, prefecture }),
  });
  const t = await r.text().catch(() => "");
  let obj;
  try { obj = JSON.parse(t); } catch { obj = { ok: false, error: t }; }
  if (!r.ok || !obj?.ok) throw new Error(obj?.error || "送料計算に失敗しました");
  // { ok:true, fee, size, region }
  return obj;
}

function getExistingShipping(order) {
  const s = order?.shipping || null;
  if (!s) return null;

  // 互換：fee / shipping_fee など
  const fee = toNum(s.fee ?? s.shipping_fee ?? s.shippingFee, NaN);
  if (!Number.isFinite(fee)) return null;

  return {
    fee,
    size: toNum(s.size ?? 0, 0),
    region: String(s.region || ""),
    from: "saved",
  };
}

function setTotals(itemsTotal, shippingFee) {
  if (sumItemsEl) sumItemsEl.textContent = yen(itemsTotal);
  if (sumShippingEl) sumShippingEl.textContent = yen(shippingFee);

  // 代引き合計 = 商品合計 + 送料 + 代引き手数料
  const totalCod = itemsTotal + shippingFee + COD_FEE;
  if (sumTotalCodEl) sumTotalCodEl.textContent = yen(totalCod);
}

// ====== Main ======
(async function main() {
  try {
    setStatus("");

    const order = loadOrder();
    const items = normalizeItems(order);

    if (!items.length) {
      renderOrderList([]);
      setTotals(0, 0);
      setStatus("商品が選択されていません。商品一覧へ戻って選択してください。");
      if (cardBtn) cardBtn.disabled = true;
      if (codBtn) codBtn.disabled = true;
      return;
    }

    renderOrderList(items);

    const itemsTotal = items.reduce((s, it) => s + it.price * it.qty, 0);

    // ✅ 送料確定ロジック（ここが重要）
    let ship = getExistingShipping(order);

    if (!ship) {
      const pref = normalizePrefecture(order);
      if (!pref) {
        // 住所が無い/都道府県が無いと計算できない
        setTotals(itemsTotal, 0);
        setStatus("都道府県が未入力のため送料を計算できません。住所入力に戻ってください。");
      } else {
        setStatus("送料を計算中…");
        const r = await calcShippingByApi(items, pref);
        ship = { fee: toNum(r.fee, 0), size: toNum(r.size, 0), region: String(r.region || ""), from: "api" };

        // 保存（次の画面でも使える）
        order.shipping = { fee: ship.fee, size: ship.size, region: ship.region };
        // itemsTotal を order に入れておく（他画面互換）
        order.itemsTotal = itemsTotal;
        saveOrderAll(order);

        setStatus("送料を反映しました。");
      }
    } else {
      // shipping が保存済みならそれを使う
      order.itemsTotal = itemsTotal;
      saveOrderAll(order);
      setStatus("送料を反映しました。");
    }

    const shippingFee = ship ? ship.fee : 0;
    setTotals(itemsTotal, shippingFee);

    // ===== ボタン遷移 =====
    if (backBtn) backBtn.onclick = () => (location.href = ADDRESS_PAGE);

    if (cardBtn) {
      cardBtn.onclick = () => {
        // クレカ側ページで order を読む前提
        location.href = CARD_DETAIL_PAGE;
      };
    }

    if (codBtn) {
      codBtn.onclick = () => {
        // 代引側ページで order を読む前提
        // 代引き合計も保存しておくと楽
        order.payment = { method: "cod", cod_fee: COD_FEE };
        order.totalCod = itemsTotal + shippingFee + COD_FEE;
        saveOrderAll(order);
        location.href = COD_DETAIL_PAGE;
      };
    }

  } catch (e) {
    setTotals(0, 0);
    setStatus("エラー: " + (e?.message || e));
    if (cardBtn) cardBtn.disabled = true;
    if (codBtn) codBtn.disabled = true;
  }
})();
