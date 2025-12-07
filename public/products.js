// products.js — オンライン注文（商品一覧）画面用
// - /api/products から商品一覧を取得
// - 個数をカートとして管理
// - sessionStorage["isoOrder"] に { items:[{id, qty}] } を保存
// - 「住所入力へ進む」で liff-address.html へ遷移

const productGridEl  = document.getElementById("productGrid");
const cartSummaryEl  = document.getElementById("cartSummary");
const toAddressBtn   = document.getElementById("toAddressBtn");
const statusEl       = document.getElementById("statusMsg");

// カート： { [productId]: { product, qty } }
const cart = {};

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

// ---- カート表示更新 ----
function updateCartSummary() {
  const entries = Object.values(cart).filter(e => e.qty > 0);
  if (!entries.length) {
    cartSummaryEl.textContent = "カートに商品は入っていません。";
    return;
  }

  let totalQty   = 0;
  let itemsTotal = 0;

  const lines = entries.map(e => {
    const line = (Number(e.product.price) || 0) * e.qty;
    totalQty   += e.qty;
    itemsTotal += line;
    return `${e.product.name} × ${e.qty} = ${yen(line)}`;
  });

  lines.push("");
  lines.push(`合計点数：${totalQty}点`);
  lines.push(`商品合計：${yen(itemsTotal)}`);

  cartSummaryEl.textContent = lines.join("\n");
}

// ---- 商品カード生成 ----
function createProductCard(p) {
  const card = document.createElement("div");
  card.className = "card";

  const img = document.createElement("img");
  if (p.image) {
    img.src = p.image;
    img.alt = p.name || "";
  } else {
    img.style.display = "none";
  }

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = p.name || "";

  const desc = document.createElement("div");
  desc.className = "card-desc";
  desc.textContent = p.desc || "";

  const volume = document.createElement("div");
  volume.className = "card-volume";
  volume.textContent = p.volume ? p.volume : "";

  const price = document.createElement("div");
  price.className = "card-price";
  price.textContent = `価格：${yen(p.price)}`;

  const stock = document.createElement("div");
  stock.className = "card-stock";
  stock.textContent = `在庫：${p.stock ?? 0}個`;

  const qtyRow = document.createElement("div");
  qtyRow.className = "qty-row";

  const minusBtn = document.createElement("button");
  minusBtn.textContent = "−";

  const qtySpan = document.createElement("span");
  qtySpan.textContent = "0";

  const plusBtn = document.createElement("button");
  plusBtn.textContent = "+";

  qtyRow.appendChild(minusBtn);
  qtyRow.appendChild(qtySpan);
  qtyRow.appendChild(plusBtn);

  card.appendChild(img);
  card.appendChild(title);
  card.appendChild(desc);
  if (p.volume) card.appendChild(volume);
  card.appendChild(price);
  card.appendChild(stock);
  card.appendChild(qtyRow);

  // 初期カート
  cart[p.id] = {
    product: p,
    qty: 0,
  };

  plusBtn.addEventListener("click", () => {
    const entry = cart[p.id];
    const now = entry.qty || 0;
    const max = Number(p.stock ?? 0) || 0;
    if (max && now >= max) {
      setStatus(`「${p.name}」の在庫は ${max}個までです。`, "err");
      return;
    }
    entry.qty = now + 1;
    qtySpan.textContent = String(entry.qty);
    setStatus("", "");
    updateCartSummary();
  });

  minusBtn.addEventListener("click", () => {
    const entry = cart[p.id];
    const now = entry.qty || 0;
    if (now <= 0) return;
    entry.qty = now - 1;
    qtySpan.textContent = String(entry.qty);
    setStatus("", "");
    updateCartSummary();
  });

  return card;
}

// ---- 商品一覧取得 ----
async function loadProducts() {
  try {
    setStatus("商品情報を読み込んでいます…", "");
    const res = await fetch("/api/products");
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error("products api error");
    }
    const items = Array.isArray(data.products) ? data.products : [];
    if (!items.length) {
      productGridEl.innerHTML =
        "<div>商品が登録されていません。</div>";
      setStatus("", "");
      return;
    }

    // グリッドに挿入
    productGridEl.innerHTML = "";
    items.forEach(p => {
      const card = createProductCard(p);
      productGridEl.appendChild(card);
    });

    setStatus("", "");
    updateCartSummary();
  } catch (e) {
    console.error("/api/products error:", e);
    productGridEl.innerHTML =
      "<div>商品情報の読み込みに失敗しました。</div>";
    setStatus("商品情報の取得に失敗しました。時間をおいて再度お試しください。", "err");
  }
}

// ---- 住所入力へ進む ----
toAddressBtn.addEventListener("click", () => {
  const entries = Object.values(cart).filter(e => e.qty > 0);
  if (!entries.length) {
    setStatus("カートに商品がありません。数量を1つ以上選択してください。", "err");
    return;
  }

  const itemsForOrder = entries.map(e => ({
    id: e.product.id,
    qty: e.qty,
  }));

  try {
    const payload = { items: itemsForOrder };
    sessionStorage.setItem("isoOrder", JSON.stringify(payload));
  } catch (e) {
    console.warn("sessionStorage isoOrder write error:", e);
  }

  // ★ 住所入力画面へ遷移（この後 liff-address.js 側で confirm.html へ）
  window.location.href = "./liff-address.html";
});

// ---- 初期化 ----
window.addEventListener("DOMContentLoaded", () => {
  loadProducts();
});
