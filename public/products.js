// /public/products.js
// 商品一覧 → カート → 「②お届け先入力へ」
// ②を押したら必ず LIFFエンドポイントへ戻す（need=shipping付き）
// products.html が need=shipping を検知して住所入力へ自然遷移する

(async function () {
  const grid = document.getElementById("productGrid");
  const toConfirmBtn = document.getElementById("toConfirmBtn");
  const clearCartBtn = document.getElementById("clearCartBtn");
  const cartTotalEl = document.getElementById("cartTotal");

  // --------- 状態 ---------
  let products = [];
  let cart = {}; // { productId: qty }

  // --------- util ---------
  const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;

  function loadCart() {
    try {
      cart = JSON.parse(localStorage.getItem("cart") || "{}") || {};
    } catch {
      cart = {};
    }
  }
  function saveCart() {
    localStorage.setItem("cart", JSON.stringify(cart));
  }

  function cartItems() {
    const items = [];
    for (const id of Object.keys(cart)) {
      const qty = Number(cart[id] || 0);
      if (qty <= 0) continue;
      const p = products.find((x) => x.id === id);
      if (!p) continue;
      items.push({
        id: p.id,
        name: p.name,
        price: Number(p.price || 0),
        qty,
        volume: p.volume || "",
        image: p.image || ""
      });
    }
    return items;
  }

  function calcTotal(items) {
    return items.reduce((sum, it) => sum + it.price * it.qty, 0);
  }

  function updateFooter() {
    const items = cartItems();
    const total = calcTotal(items);
    cartTotalEl.textContent = yen(total);

    const hasItems = items.length > 0;
    toConfirmBtn.disabled = !hasItems;
    clearCartBtn.disabled = !hasItems;
  }

  // --------- fetch products ---------
  async function fetchProducts() {
    try {
      const res = await fetch("/api/products", { cache: "no-store" });
      const data = await res.json();
      if (!data || !data.ok || !Array.isArray(data.products)) return [];
      return data.products;
    } catch (e) {
      console.error("products fetch error", e);
      return [];
    }
  }

  // --------- render ---------
  function render() {
    grid.innerHTML = "";
    if (!products.length) {
      grid.innerHTML = `<div class="empty">商品データがありません</div>`;
      return;
    }

    products.forEach((p) => {
      const qty = Number(cart[p.id] || 0);

      const card = document.createElement("div");
      card.className = "card";

      const imgWrap = document.createElement("div");
      imgWrap.className = "img";
      if (p.image) {
        const img = document.createElement("img");
        img.src = p.image;
        img.alt = p.name;
        img.loading = "lazy";
        imgWrap.appendChild(img);
      } else {
        imgWrap.textContent = "画像なし";
      }

      const body = document.createElement("div");
      body.className = "body";

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = p.name;

      const volume = document.createElement("div");
      volume.className = "stock";
      volume.textContent = p.volume ? `内容量：${p.volume}` : "";

      const desc = document.createElement("div");
      desc.className = "desc";
      desc.textContent = p.desc || "";

      const price = document.createElement("div");
      price.className = "price";
      price.textContent = yen(p.price);

      const stock = document.createElement("div");
      stock.className = "stock";
      stock.textContent = `在庫：${p.stock ?? 0}`;

      const qtyRow = document.createElement("div");
      qtyRow.className = "qty-row";

      const minusBtn = document.createElement("button");
      minusBtn.className = "qty-btn";
      minusBtn.textContent = "−";
      minusBtn.onclick = () => {
        cart[p.id] = Math.max(0, Number(cart[p.id] || 0) - 1);
        saveCart();
        render();
      };

      const qtyEl = document.createElement("div");
      qtyEl.className = "qty";
      qtyEl.textContent = qty;

      const plusBtn = document.createElement("button");
      plusBtn.className = "qty-btn";
      plusBtn.textContent = "＋";
      plusBtn.onclick = () => {
        cart[p.id] = Math.min(99, Number(cart[p.id] || 0) + 1);
        saveCart();
        render();
      };

      qtyRow.appendChild(minusBtn);
      qtyRow.appendChild(qtyEl);
      qtyRow.appendChild(plusBtn);

      body.appendChild(name);
      if (volume.textContent) body.appendChild(volume);
      body.appendChild(desc);
      body.appendChild(price);
      body.appendChild(stock);
      body.appendChild(qtyRow);

      card.appendChild(imgWrap);
      card.appendChild(body);
      grid.appendChild(card);
    });

    updateFooter();
  }

  // --------- events ---------
  clearCartBtn.onclick = () => {
    cart = {};
    saveCart();
    render();
  };

  toConfirmBtn.onclick = async () => {
    const items = cartItems();
    if (!items.length) return;

    // いったん注文下書きを保存して住所へ
    const payload = {
      items,
      itemsTotal: calcTotal(items),
    };
    sessionStorage.setItem("orderDraft", JSON.stringify(payload));

    // LIFF ID を取り、need=shipping 付きでエンドポイント(products)へ戻す
    try {
      const confRes = await fetch("/api/liff/config", { cache: "no-store" });
      const conf = await confRes.json();
      const liffId = conf?.liffId;

      if (liffId) {
        location.href = `https://liff.line.me/${liffId}?from=products&need=shipping`;
        return;
      }
    } catch (e) {
      console.error("liff config fetch error", e);
    }

    // 保険（LIFF ID 取れない場合）
    location.href = "/public/liff-address.html";
  };

  // --------- init ---------
  loadCart();
  products = await fetchProducts();
  render();
})();
