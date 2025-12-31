"use strict";

const grid = document.getElementById("productGrid");
const cartSummary = document.getElementById("cartSummary");
const toAddressBtn = document.getElementById("toAddressBtn");
const statusMsg = document.getElementById("statusMsg");

function setStatus(msg = "") { if (statusMsg) statusMsg.textContent = msg; }
function yen(n) { const x = Number(n || 0); return `${x.toLocaleString("ja-JP")}円`; }
function toNum(x, fallback = 0) {
  const n = Number(String(x ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : fallback;
}
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

// ===== 商品/カート =====
let products = [];
let cart = {};

function loadCartFromAny() {
  const candidates = ["cart", "cartItems", "items", "currentOrder", "order", "orderDraft"];
  for (const k of candidates) {
    const v = sessionStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (!j) continue;

    if (j.items && Array.isArray(j.items)) {
      const out = {};
      for (const it of j.items) {
        const id = String(it.id ?? it.productId ?? "").trim();
        const qty = toNum(it.qty ?? it.quantity ?? 0, 0);
        if (id && qty > 0) out[id] = (out[id] || 0) + qty;
      }
      if (Object.keys(out).length) return out;
    }

    if (Array.isArray(j)) {
      const out = {};
      for (const it of j) {
        const id = String(it.id ?? it.productId ?? "").trim();
        const qty = toNum(it.qty ?? it.quantity ?? 0, 0);
        if (id && qty > 0) out[id] = (out[id] || 0) + qty;
      }
      if (Object.keys(out).length) return out;
    }

    if (typeof j === "object" && j && !Array.isArray(j)) {
      const out = {};
      const keys = Object.keys(j);
      const looksLikeQtyMap = keys.some((kk) => typeof j[kk] === "number" || /^\d+$/.test(String(j[kk] ?? "")));
      if (looksLikeQtyMap) {
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
      volume: p.volume || "",
    });
  }
  const itemsTotal = items.reduce((s, it) => s + toNum(it.price) * toNum(it.qty), 0);

  return {
    items,
    itemsTotal,
    address: null,
    shipping_fee: 0,
    createdAt: new Date().toISOString(),
  };
}

function saveOrderForNext() {
  const payload = buildOrderPayload();
  sessionStorage.setItem("orderDraft", JSON.stringify(payload));
  sessionStorage.setItem("order", JSON.stringify(payload));
  sessionStorage.setItem("currentOrder", JSON.stringify(payload));
  sessionStorage.setItem("confirm_normalized_order", JSON.stringify(payload));
  localStorage.setItem("order", JSON.stringify(payload));
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

  saveOrderForNext();
  renderCards();
  renderSummary();
}

function imgUrlFromFilename(filename) {
  const fn = String(filename || "").trim();
  if (!fn) return "/public/noimage.png";
  // filenameだけなら uploads へ
  if (!/^https?:\/\//i.test(fn) && !fn.startsWith("/")) {
    return `/public/uploads/${fn}`;
  }
  // 既にURL/絶対パスならそのまま
  return fn;
}

function renderCards() {
  grid.innerHTML = "";

  for (const p of products) {
    const card = document.createElement("div");
    card.className = "card";

    const img = document.createElement("img");
    img.alt = p.name || "商品画像";
    img.src = imgUrlFromFilename(p.image);
    img.onerror = () => { img.style.display = "none"; };

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = p.name || "";

    const desc = document.createElement("div");
    desc.className = "card-desc";
    desc.textContent = p.desc || "";

    const volume = document.createElement("div");
    volume.className = "card-volume";
    volume.textContent = p.volume ? `内容量：${p.volume}` : "";

    const price = document.createElement("div");
    price.className = "card-price";
    price.textContent = `価格：${yen(p.price)}`;

    const stock = document.createElement("div");
    stock.className = "card-stock";
    stock.textContent = `在庫：${toNum(p.stock ?? 0, 0)}個`;

    const qtyRow = document.createElement("div");
    qtyRow.className = "qty-row";

    const minus = document.createElement("button");
    minus.textContent = "−";
    minus.addEventListener("click", () => updateQty(p.id, -1));

    const qty = document.createElement("span");
    qty.textContent = String(toNum(cart[p.id] || 0, 0));

    const plus = document.createElement("button");
    plus.textContent = "+";
    plus.addEventListener("click", () => updateQty(p.id, +1));

    qtyRow.appendChild(minus);
    qtyRow.appendChild(qty);
    qtyRow.appendChild(plus);

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
  const r = await fetch("/api/products");
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(j?.error || "商品取得に失敗しました");

  products = (j.products || []).map((p) => ({
    id: String(p.id || "").trim(),
    name: String(p.name || "").trim(),
    price: toNum(p.price, 0),
    stock: toNum(p.stock ?? 0, 0),
    desc: String(p.desc || ""),
    volume: String(p.volume || ""),
    image: String(p.image || ""), // filename
  })).filter((p) => p.id);

  setStatus("");
}

function goToAddress() {
  const payload = buildOrderPayload();
  if (!payload.items.length) {
    setStatus("商品を選んでください。");
    return;
  }
  saveOrderForNext();
  location.href = "./liff-address.html";
}

(async function main() {
  try {
    cart = loadCartFromAny();
    await loadProducts();
    renderCards();

    const ids = new Set(products.map((p) => p.id));
    for (const k of Object.keys(cart)) if (!ids.has(k)) delete cart[k];

    saveOrderForNext();
    renderSummary();

    toAddressBtn.addEventListener("click", goToAddress);
  } catch (e) {
    setStatus(`エラー：${e?.message || e}`);
    toAddressBtn.disabled = true;
  }
})();
