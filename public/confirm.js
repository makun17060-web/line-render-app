"use strict";

/**
 * confirm.js — 注文確認（合計表示） 安定版
 * - 商品合計(sumItems) / 送料(sumShipping) / 代引合計(sumTotalCod) を確実に表示
 * - localStorage / sessionStorage の複数キーを探索して読み込み
 * - 価格や数量が文字列でも必ず数値化して計算
 * - 送料は /api/shipping が使える場合は呼んで反映（失敗時は0円で継続）
 */

// ====== DOM helpers ======
function $(id) { return document.getElementById(id); }
function setText(id, text) { const el = $(id); if (el) el.textContent = text; }
function yen(n) { return `${Number(n || 0).toLocaleString("ja-JP")}円`; }

// ====== number helpers ======
function toNum(x, fallback = 0) {
  const n = Number(String(x ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : fallback;
}

// ====== storage helpers ======
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function loadOrderFromStorage() {
  // ありがちな保存キーを総当たり（あなたの環境に合わせて増やしてOK）
  const candidates = [
    // よくある
    "order",
    "orderDraft",
    "currentOrder",
    "cart",
    "cartItems",
    "items",
    // 磯屋っぽい名前も想定
    "isoya_order",
    "isoya_cart",
    "iso_order",
    "iso_cart",
    // セッションにも念のため
    "order_session",
    "cart_session",
  ];

  // 1) sessionStorage 優先
  for (const k of candidates) {
    const v = sessionStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (j) return { key: k, data: j, where: "sessionStorage" };
  }

  // 2) localStorage
  for (const k of candidates) {
    const v = localStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (j) return { key: k, data: j, where: "localStorage" };
  }

  return { key: null, data: null, where: null };
}

// ====== normalize order structure ======
function normalizeItems(raw) {
  // raw が {items:[...]} / [...] / {cartItems:[...]} など色々でも吸収
  let items = null;

  if (Array.isArray(raw)) items = raw;
  else if (raw && Array.isArray(raw.items)) items = raw.items;
  else if (raw && Array.isArray(raw.cartItems)) items = raw.cartItems;
  else if (raw && Array.isArray(raw.products)) items = raw.products;

  if (!Array.isArray(items)) return [];

  return items
    .map((it) => ({
      id: String(it.id ?? it.productId ?? "").trim(),
      name: String(it.name ?? it.productName ?? it.title ?? "商品").trim(),
      price: toNum(it.price ?? it.unitPrice ?? it.amount ?? 0, 0),
      qty: toNum(it.qty ?? it.quantity ?? it.count ?? 0, 0),
    }))
    .filter((it) => it.qty > 0);
}

function normalizeAddress(raw) {
  // raw.address があれば使う。なければ raw 自体が住所っぽければそのまま。
  const a = raw?.address && typeof raw.address === "object" ? raw.address : (raw && typeof raw === "object" ? raw : null);
  if (!a) return null;

  return {
    postal: String(a.postal ?? a.zip ?? "").trim(),
    prefecture: String(a.prefecture ?? a.pref ?? "").trim(),
    city: String(a.city ?? "").trim(),
    address1: String(a.address1 ?? a.addr1 ?? "").trim(),
    address2: String(a.address2 ?? a.addr2 ?? "").trim(),
    name: String(a.name ?? "").trim(),
    phone: String(a.phone ?? a.tel ?? "").trim(),
  };
}

// ====== calc ======
function calcItemsTotal(items) {
  return items.reduce((sum, it) => sum + (toNum(it.price) * toNum(it.qty)), 0);
}

// ====== render ======
function renderOrderList(items) {
  const box = $("orderList");
  if (!box) return;
  if (!items.length) {
    box.innerHTML = `<div class="order-row">商品がありません（カートが空です）</div>`;
    return;
  }

  box.innerHTML = items
    .map((it) => {
      const lineTotal = toNum(it.price) * toNum(it.qty);
      return `<div class="order-row">・${escapeHtml(it.name)} ×${toNum(it.qty)} = ${yen(lineTotal)}</div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(msg) {
  const el = $("statusMsg");
  if (el) el.textContent = msg || "";
}

// ====== shipping fetch ======
async function fetchShipping(items, address) {
  // address が無いと送料計算できないので 0
  if (!address || !address.prefecture) return { shipping: 0, region: "", size: "" };

  try {
    const r = await fetch("/api/shipping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, address }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) return { shipping: 0, region: "", size: "" };

    return {
      shipping: toNum(j.shipping, 0),
      region: String(j.region || ""),
      size: String(j.size || ""),
    };
  } catch {
    return { shipping: 0, region: "", size: "" };
  }
}

// ====== main ======
(async function main() {
  // 固定（HTMLに表示があるので）
  const COD_FEE = 330;

  // 1) まず注文データを読む
  const loaded = loadOrderFromStorage();
  const raw = loaded.data;

  const items = normalizeItems(raw);
  const address = normalizeAddress(raw);

  // 2) 表示（商品リスト）
  renderOrderList(items);

  // 3) 商品合計（ここが “反映されない” を確実に潰す）
  const itemsTotal = calcItemsTotal(items);
  setText("sumItems", yen(itemsTotal));

  // 4) 送料（取れれば反映、ダメでも0で続行）
  setText("sumShipping", yen(0));
  setText("sumTotalCod", yen(itemsTotal + 0 + COD_FEE));

  const ship = await fetchShipping(
    // APIは it.price/it.qty を使うので形式合わせ
    items.map((x) => ({ id: x.id, name: x.name, price: x.price, qty: x.qty })),
    address
  );

  const shipping = toNum(ship.shipping, 0);
  setText("sumShipping", yen(shipping));

  // 代引き合計（代引き手数料は固定330円）
  const totalCod = itemsTotal + shipping + COD_FEE;
  setText("sumTotalCod", yen(totalCod));

  // 5) ステータス
  if (!items.length) {
    setStatus("カートが空です。商品一覧に戻って追加してください。");
  } else {
    const from = loaded.key ? `${loaded.where}:${loaded.key}` : "（保存データなし）";
    const addrOk = address?.prefecture ? "住所OK" : "住所未取得（送料は0円表示）";
    setStatus(`読み込み：${from}\n明細：${items.length}件 / 商品合計：${yen(itemsTotal)} / 送料：${yen(shipping)}\n${addrOk}`);
  }

  // 6) ボタン動作（必要に応じて行き先変更してOK）
  // ここでは「次ページへ進むだけ」になってます。
  const cardBtn = $("cardBtn");
  const codBtn = $("codBtn");
  const backBtn = $("backBtn");

  // 次ページで使えるように、正規化した注文を sessionStorage に保存して渡す
  const normalizedOrder = {
    items,
    address,
    itemsTotal,
    shipping,
    codFee: COD_FEE,
    totalCod,
  };
  sessionStorage.setItem("confirm_normalized_order", JSON.stringify(normalizedOrder));

  if (cardBtn) {
    cardBtn.addEventListener("click", () => {
      // 例：カード明細ページへ（あなたのファイル名に合わせて変更）
      // location.href = "./confirm-card.html";
      setStatus("カード明細ページのURLをconfirm.js内で設定してください（例：confirm-card.html）");
    });
  }

  if (codBtn) {
    codBtn.addEventListener("click", () => {
      // 例：代引き明細ページへ（あなたのファイル名に合わせて変更）
      // location.href = "./confirm-cod.html;
      setStatus("代引き明細ページのURLをconfirm.js内で設定してください（例：confirm-cod.html）");
    });
  }

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      // 例：住所入力ページへ戻る（あなたのファイル名に合わせて変更）
      history.back();
    });
  }
})();
