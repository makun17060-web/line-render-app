// /public/products.js
// /api/products のレスポンス: { ok:true, products:[{id,name,volume,price,stock,desc,image}, ...] }
// 商品一覧描画 + 数量 +/- + 合計計算 + confirm.html へ遷移

(async function () {
  const grid = document.getElementById("productGrid");
  const cartTotalEl = document.getElementById("cartTotal");
  const clearCartBtn = document.getElementById("clearCartBtn");
  const toConfirmBtn = document.getElementById("toConfirmBtn");

  // -----------------------------
  // カート state
  // -----------------------------
  const cart = {}; // { productId: { ...product, qty } }

  const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;

  function calcTotal() {
    return Object.values(cart).reduce((sum, it) => {
      return sum + (Number(it.price) || 0) * (Number(it.qty) || 0);
    }, 0);
  }

  function updateFooter() {
    const total = calcTotal();
    cartTotalEl.textContent = yen(total);

    const hasItems = total > 0;
    clearCartBtn.disabled = !hasItems;
    toConfirmBtn.disabled = !hasItems;
  }

  function setQty(p, qty) {
    const q = Math.max(0, Math.min(99, Number(qty) || 0));
    if (q <= 0) {
      delete cart[p.id];
    } else {
      cart[p.id] = { ...p, qty: q };
    }
    updateFooter();
    // 画面の数量表示を更新
    const qtyEl = document.querySelector(`[data-qty-id="${p.id}"]`);
    if (qtyEl) qtyEl.textContent = q;
  }

  // -----------------------------
  // 商品取得
  // -----------------------------
  async function fetchProducts() {
    try {
      const res = await fetch("/api/products", { cache: "no-store" });
      const data = await res.json();
      if (!data || !data.ok || !Array.isArray(data.products)) return [];
      return data.products;
    } catch (e) {
      console.error("商品一覧取得失敗:", e);
      return [];
    }
  }

  const products = await fetchProducts();

  // -----------------------------
  // 描画
  // -----------------------------
  grid.innerHTML = "";
  if (products.length === 0) {
    grid.innerHTML = `<div class="empty">商品がありません。</div>`;
    updateFooter();
    return;
  }

  products.forEach((p) => {
    const card = document.createElement("div");
    card.className = "card";

    // ★ 画像崩れ防止：.img 枠の中に必ず img を入れる
    const imgWrap = document.createElement("div");
    imgWrap.className = "img";

    const img = document.createElement("img");
    img.src = p.image || "";
    img.alt = p.name || "";
    img.loading = "lazy";

    // 画像が無い／壊れてる場合の保険
    img.onerror = () => {
      imgWrap.textContent = "画像なし";
      img.remove();
    };

    if (p.image) {
      imgWrap.appendChild(img);
    } else {
      imgWrap.textContent = "画像なし";
    }

    const body = document.createElement("div");
    body.className = "body";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = p.name || "";

    // ★ 内容量（volume）表示
    const volume = document.createElement("div");
    volume.className = "stock"; // 小さめ表示に流用
    volume.textContent = p.volume ? `内容量：${p.volume}` : "";

    const desc = document.createElement("div");
    desc.className = "desc";
    desc.textContent = p.desc || "";

    const price = document.createElement("div");
    price.className = "price";
    price.textContent = `価格：${yen(p.price)}`;

    const stock = document.createElement("div");
    stock.className = "stock";
    stock.textContent = `在庫：${p.stock ?? 0}`;

    const qtyRow = document.createElement("div");
    qtyRow.className = "qty-row";

    const minusBtn = document.createElement("button");
    minusBtn.className = "qty-btn";
    minusBtn.textContent = "−";

    const qtyEl = document.createElement("div");
    qtyEl.className = "qty";
    qtyEl.dataset.qtyId = p.id;
    qtyEl.textContent = "0";

    const plusBtn = document.createElement("button");
    plusBtn.className = "qty-btn";
    plusBtn.textContent = "＋";

    minusBtn.onclick = () => {
      const current = cart[p.id]?.qty || 0;
      setQty(p, current - 1);
    };
    plusBtn.onclick = () => {
      const current = cart[p.id]?.qty || 0;
      // 在庫上限（在庫が数値の時だけ）
      const maxStock = Number.isFinite(Number(p.stock)) ? Number(p.stock) : 99;
      if (current + 1 > maxStock) return;
      setQty(p, current + 1);
    };

    qtyRow.appendChild(minusBtn);
    qtyRow.appendChild(qtyEl);
    qtyRow.appendChild(plusBtn);

    body.appendChild(name);
    if (p.volume) body.appendChild(volume); // volume空なら表示しない
    body.appendChild(desc);
    body.appendChild(price);
    body.appendChild(stock);
    body.appendChild(qtyRow);

    card.appendChild(imgWrap);
    card.appendChild(body);
    grid.appendChild(card);
  });

  updateFooter();

  // -----------------------------
  // カート操作
  // -----------------------------
  clearCartBtn.onclick = () => {
    Object.keys(cart).forEach((k) => delete cart[k]);
    // 表示を全部0に
    document.querySelectorAll("[data-qty-id]").forEach((el) => {
      el.textContent = "0";
    });
    updateFooter();
  };

  // confirm.html へ
  toConfirmBtn.onclick = () => {
    const items = Object.values(cart).map((it) => ({
      id: it.id,
      name: it.name,
      volume: it.volume || "",
      price: it.price,
      qty: it.qty,
      image: it.image || "",
    }));

    if (items.length === 0) return;

    const itemsTotal = calcTotal();

    // 次画面用に sessionStorage に保存
    sessionStorage.setItem("order_items", JSON.stringify(items));
    sessionStorage.setItem("order_itemsTotal", String(itemsTotal));

    // confirm.htmlへ
    location.href = "/public/confirm.html";
  };
})();
