// public/products.js
// /api/products のレスポンス
// { ok: true, products: [ { id, name, volume, price, stock, desc, image }, ... ] }
// を使って商品一覧を描画し、confirm.html へ注文データを渡す
//
// 仕様:
// - 内容量(volume) があれば「内容量：xxx」を表示
// - 在庫(stock)が0の時は購入不可表示
// - 数量 +/- でカート(orders)に反映
// - 「注文内容を確認」ボタンで confirm.html に遷移（localStorage に保存）

(async function () {
  const grid = document.getElementById("productGrid");
  const toConfirmBtn = document.getElementById("toConfirmBtn");
  const statusMsg = document.getElementById("statusMsg");

  const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;

  function setStatus(text) {
    if (!statusMsg) return;
    statusMsg.textContent = text || "";
  }

  // ====== 商品一覧取得 ======
  async function fetchProducts() {
    try {
      const res = await fetch("/api/products", { cache: "no-store" });
      const data = await res.json();

      if (!data || !data.ok || !Array.isArray(data.products)) {
        console.error("想定外のレスポンス形式:", data);
        return [];
      }
      return data.products;
    } catch (e) {
      console.error("商品一覧の取得に失敗:", e);
      return [];
    }
  }

  // ====== カート（localStorage） ======
  const CART_KEY = "orders";

  function readCart() {
    try {
      const raw = localStorage.getItem(CART_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function writeCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart || []));
  }

  function upsertCartItem(product, qty) {
    const cart = readCart();
    const idx = cart.findIndex((x) => x.id === product.id);
    if (idx >= 0) {
      if (qty <= 0) cart.splice(idx, 1);
      else cart[idx].qty = qty;
    } else {
      if (qty > 0) {
        cart.push({
          id: product.id,
          name: product.name,
          volume: product.volume || "",
          price: product.price,
          qty,
          stock: product.stock ?? 0,
          image: product.image || "",
          desc: product.desc || "",
        });
      }
    }
    writeCart(cart);
    refreshConfirmButton(cart);
  }

  function getQty(productId) {
    const cart = readCart();
    const item = cart.find((x) => x.id === productId);
    return item ? Number(item.qty || 0) : 0;
  }

  // ====== 注文内容確認ボタン ======
  function refreshConfirmButton(cart) {
    const items = cart || readCart();
    const totalQty = items.reduce((s, it) => s + Number(it.qty || 0), 0);

    if (toConfirmBtn) {
      toConfirmBtn.disabled = totalQty === 0;
      toConfirmBtn.textContent =
        totalQty === 0
          ? "商品を選んでください"
          : `注文内容を確認（${totalQty}点）`;
    }
  }

  if (toConfirmBtn) {
    toConfirmBtn.addEventListener("click", () => {
      const cart = readCart();
      if (!cart.length) return;
      // confirm.html へ
      location.href = "/public/confirm.html";
    });
  }

  // ====== UI：商品カード ======
  function createProductCard(p) {
    const qtyNow = getQty(p.id);
    const stock = Number(p.stock ?? 0);

    const card = document.createElement("div");
    card.className = "product-card";

    const img = p.image ? String(p.image) : "";

    card.innerHTML = `
      <div class="img-wrap">
        ${img ? `<img src="${img}" alt="${p.name}">` : `<div class="noimg">No Image</div>`}
      </div>

      <div class="info">
        <h3 class="name">${p.name}</h3>

        ${p.volume ? `<div class="volume">内容量：${p.volume}</div>` : ""}

        <div class="price">価格：${yen(p.price)}</div>
        <div class="stock">在庫：${stock}個</div>

        ${p.desc ? `<div class="desc">${p.desc}</div>` : ""}

        <div class="qty-row">
          <button class="qty-btn minus" ${stock <= 0 ? "disabled" : ""}>−</button>
          <div class="qty-num">${qtyNow}</div>
          <button class="qty-btn plus" ${stock <= 0 ? "disabled" : ""}>＋</button>
        </div>

        ${stock <= 0 ? `<div class="soldout">在庫切れ</div>` : ""}
      </div>
    `;

    const minusBtn = card.querySelector(".qty-btn.minus");
    const plusBtn = card.querySelector(".qty-btn.plus");
    const qtyNum = card.querySelector(".qty-num");

    function setQtyUI(n) {
      qtyNum.textContent = String(n);
    }

    if (minusBtn) {
      minusBtn.addEventListener("click", () => {
        let n = getQty(p.id);
        n = Math.max(0, n - 1);
        upsertCartItem(p, n);
        setQtyUI(n);
      });
    }

    if (plusBtn) {
      plusBtn.addEventListener("click", () => {
        let n = getQty(p.id);
        if (stock > 0) n = Math.min(stock, n + 1);
        upsertCartItem(p, n);
        setQtyUI(n);
      });
    }

    return card;
  }

  // ====== 初期描画 ======
  setStatus("商品を読み込み中...");
  const products = await fetchProducts();

  grid.innerHTML = "";
  products.forEach((p) => {
    grid.appendChild(createProductCard(p));
  });

  refreshConfirmButton(readCart());
  setStatus(products.length ? "" : "商品がありません。");
})();
