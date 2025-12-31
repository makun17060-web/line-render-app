"use strict";

/**
 * products.js — 商品一覧（オンライン注文）
 * - /api/products から商品を取得
 * - 数量 + / - でカート作成
 * - 「住所入力へ進む」で order/currentOrder に保存して liff-address.html へ
 *
 * 重要：
 * ✅ confirm.js / liff-address.js が確実に拾えるよう、保存キーを統一します
 *   - sessionStorage: order / currentOrder / orderDraft / confirm_normalized_order
 *   - localStorage  : order
 *
 * ✅ 修正点（今回）
 * - products.json の image は「ファイル名」なので、そのままだと表示されない
 * - 正しくは /public/uploads/<filename> で配信されているため、
 *   img.src を必ずその形に組み立てる（URL/絶対パスにも互換対応）
 */

const grid = document.getElementById("productGrid");
const cartSummary = document.getElementById("cartSummary");
const toAddressBtn = document.getElementById("toAddressBtn");
const statusMsg = document.getElementById("statusMsg");

function setStatus(msg = "") {
  if (statusMsg) statusMsg.textContent = msg;
}

function yen(n) {
  const x = Number(n || 0);
  return `${x.toLocaleString("ja-JP")}円`;
}

function toNum(x, fallback = 0) {
  const n = Number(String(x ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * ★画像URLを正規化
 * - 画像がURL(https://...)ならそのまま
 * - / から始まるならそのまま（例 /public/uploads/xxx.jpg）
 * - ファイル名だけなら /public/uploads/<filename> を組み立てる
 */
function imageUrl(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return s;
  return "/public/uploads/" + encodeURIComponent(s);
}

// ===== 商品/カート =====
let products = [];
// cart: { [productId]: qty }
let cart = {};

// 既存のカート（もし以前の実装で入っていても拾う）
function loadCartFromAny() {
  const candidates = ["cart", "cartItems", "items", "currentOrder", "order", "orderDraft"];
  for (const k of candidates) {
    const v = sessionStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (!j) continue;

    // {items:[...]} 型
    if (j.items && Array.isArray(j.items)) {
      const out = {};
      for (const it of j.items) {
        const id = String(it.id ?? it.productId ?? "").trim();
        const qty = toNum(it.qty ?? it.quantity ?? 0, 0);
        if (id && qty > 0) out[id] = (out[id] || 0) + qty;
      }
      if (Object.keys(out).length) return out;
    }

    // 配列型
    if (Array.isArray(j)) {
      const out = {};
      for (const it of j) {
        const id = String(it.id ?? it.productId ?? "").trim();
        const qty = toNum(it.qty ?? it.quantity ?? 0, 0);
        if (id && qty > 0) out[id] = (out[id] || 0) + qty;
      }
      if (Object.keys(out).length) return out;
    }

    // { [id]: qty } 型
    if (typeof j === "object" && j && !Array.isArray(j)) {
      const keys = Object.keys(j);
      const looksLikeQtyMap = keys.some((kk) => typeof j[kk] === "number" || /^\d+$/.test(String(j[kk] ?? "")));
      if (looksLikeQtyMap) {
        const out = {};
        for (const kk of keys) {
          const q = toNum(j[kk], 0);
          if (q > 0) out[kk] = q;
        }
        if (Object.keys(out).length) return out;
      }
    }
  }
  return {};
}

function buildOrderPayload() {
  const items = [];
  for (const [id, qty] of Object.entries(cart)) {
    const q = toNum(qty, 0);
    if (q <= 0) continue;
    const p = products.find((x) => x.id === id);
    if (!p) continue;
    items.push({
      id: p.id,
      name: p.name,
      price: toNum(p.price, 0),
      qty: q,
      volume: p.volume || "", // ★内容量
      image: p.image || "",   // ★必要なら次画面で使える
    });
  }

  const itemsTotal = items.reduce((s, it) => s + toNum(it.price) * toNum(it.qty), 0);

  return {
    items,
    itemsTotal,
    // 住所は住所画面で入る（ここでは空）
    address: null,
    createdAt: new Date().toISOString(),
  };
}

function saveOrderForNext() {
  const payload = buildOrderPayload();

  // ✅ confirm / address が絶対に読めるキーへ保存（複数）
  sessionStorage.setItem("order", JSON.stringify(payload));
  sessionStorage.setItem("currentOrder", JSON.stringify(payload));
  sessionStorage.setItem("orderDraft", JSON.stringify(payload));
  sessionStorage.setItem("confirm_normalized_order", JSON.stringify(payload));
  localStorage.setItem("order", JSON.stringify(payload));

  // 互換として cart も残す（必要なら）
  sessionStorage.setItem("cart", JSON.stringify(cart));
}

function renderSummary() {
  const payload = buildOrderPayload();
  if (!payload.items.length) {
    cartSummary.textContent = "カートに商品は入っていません。";
    toAddressBtn.disabled = true;
    return;
  }

  const lines = [];
  for (const it of payload.items) {
    const sub = toNum(it.price) * toNum(it.qty);
    lines.push(`${it.name} ×${it.qty} = ${yen(sub)}`);
  }
  lines.push(`\n商品合計：${yen(payload.itemsTotal)}`);

  cartSummary.textContent = lines.join("\n");
  toAddressBtn.disabled = false;
}

function updateQty(id, delta) {
  const cur = toNum(cart[id] || 0, 0);
  const next = Math.max(0, cur + delta);
  if (next === 0) delete cart[id];
  else cart[id] = next;

  // 途中でも保存しておく（戻っても復元）
  saveOrderForNext();
  renderCards();
  renderSummary();
}

function renderCards() {
  grid.innerHTML = "";

  for (const p of products) {
    const card = document.createElement("div");
    card.className = "card";

    const img = document.createElement("img");
    img.alt = p.name || "商品画像";

    // ★ここが今回の核心：/public/uploads/ に組み立てる
    img.src = imageUrl(p.image) || "/public/noimage.png";
    img.onerror = () => {
      img.src = "/public/noimage.png";
    };

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = p.name || "";

    const desc = document.createElement("div");
    desc.className = "card-desc";
    desc.textContent = p.desc || "";

    // ★内容量表示
    const volume = document.createElement("div");
    volume.className = "card-volume";
    volume.textContent = p.volume ? `内容量：${p.volume}` : "";

    const price = document.createElement("div");
    price.className = "card-price";
    price.textContent = `価格：${yen(p.price)}`;

    const stock = document.createElement("div");
    stock.className = "card-stock";
    const st = toNum(p.stock ?? 0, 0);
    stock.textContent = `在庫：${st}個`;

    const qtyRow = document.createElement("div");
    qtyRow.className = "qty-row";

    const minus = document.createElement("button");
    minus.textContent = "−";
    minus.addEventListener("click", () => updateQty(p.id, -1));

    const qty = document.createElement("span");
    qty.textContent = String(toNum(cart[p.id] || 0, 0));

    const plus = document.createElement("button");
    plus.textContent = "+";
    plus.addEventListener("click", () => {
      // 在庫上限チェック（在庫数がある場合）
      const curQty = toNum(cart[p.id] || 0, 0);
      const nextQty = curQty + 1;
      if (st >= 0 && nextQty > st) {
        setStatus(`在庫が不足です（${p.name}：在庫 ${st}）。`);
        return;
      }
      setStatus("");
      updateQty(p.id, +1);
    });

    qtyRow.appendChild(minus);
    qtyRow.appendChild(qty);
    qtyRow.appendChild(plus);

    // 画像は常に表示（noimageにfallbackするため）
    card.appendChild(img);
    card.appendChild(title);
    card.appendChild(desc);
    if (p.volume) card.appendChild(volume);
    card.appendChild(price);
    card.appendChild(stock);
    card.appendChild(qtyRow);

    grid.appendChild(card);
  }
}

async function loadProducts() {
  setStatus("商品を読み込み中...");
  const r = await fetch("/api/products", { cache: "no-store" });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(j?.error || "商品取得に失敗しました");

  // サーバは { id,name,price,stock,desc,volume,image } を返す想定
  products = (j.products || [])
    .map((p) => ({
      id: String(p.id || "").trim(),
      name: String(p.name || "").trim(),
      price: toNum(p.price, 0),
      stock: toNum(p.stock ?? 0, 0),
      desc: String(p.desc || ""),
      volume: String(p.volume || ""), // ★内容量
      image: String(p.image || ""),   // ★ファイル名（/public/uploads/で表示）
    }))
    .filter((p) => p.id);

  setStatus("");
}

function goToAddress() {
  const payload = buildOrderPayload();
  if (!payload.items.length) {
    setStatus("商品を選んでください。");
    return;
  }
  saveOrderForNext();

  // 住所入力ページへ（ファイル名が違うならここだけ変更）
  location.href = "./liff-address.html";
}

// ===== 起動 =====
(async function main() {
  try {
    cart = loadCartFromAny();

    await loadProducts();
    renderCards();

    // 読み込んだ商品に対して、存在しないIDをカートから削除
    const ids = new Set(products.map((p) => p.id));
    for (const k of Object.keys(cart)) {
      if (!ids.has(k)) delete cart[k];
    }

    saveOrderForNext();
    renderSummary();

    toAddressBtn.addEventListener("click", goToAddress);
  } catch (e) {
    setStatus(`エラー：${e?.message || e}`);
    toAddressBtn.disabled = true;
  }
})();
