// public/products.js
// products.html 用：商品一覧表示 + 数量選択 + localStorage保存 + address.htmlへ遷移

(function () {
  const grid = document.getElementById("productGrid");
  const toConfirmBtn = document.getElementById("toConfirmBtn");

  const STORAGE_KEY = "isoya_order_v1";

  function loadOrder() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }
  function saveOrder(partial) {
    const cur = loadOrder();
    const next = { ...cur, ...partial, updatedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }
  function calcTotal(items = []) {
    return items.reduce(
      (sum, it) => sum + Number(it.price || 0) * Number(it.qty || 0),
      0
    );
  }

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

  // カート復元
  const order = loadOrder();
  let cart = Array.isArray(order.items) ? order.items : [];

  function getQty(pid) {
    const it = cart.find((x) => x.id === pid);
    return it ? Number(it.qty || 0) : 0;
  }

  function setQty(p, qty) {
    qty = Math.max(0, Math.floor(Number(qty || 0)));

    // 0なら削除
    cart = cart.filter((x) => x.id !== p.id);
    if (qty > 0) {
      cart.push({
        id: p.id,
        name: p.name,
        price: Number(p.price || 0),
        qty,
        image: p.image || "",
      });
    }
    saveOrder({ items: cart });

    // ボタン有効/無効
    toConfirmBtn.disabled = calcTotal(cart) <= 0;
  }

  function renderProducts(products) {
    grid.innerHTML = "";

    products.forEach((p) => {
      // 久助は画面に出さない（名前に久助が入ってたらスキップ）
      if (String(p.name || "").includes("久助")) return;

      const qty = getQty(p.id);

      const card = document.createElement("div");
      card.className = "card";

      card.innerHTML = `
        <img src="${p.image || ""}" alt="${p.name || ""}" onerror="this.style.display='none'" />
        <div class="card-body">
          <div class="card-title">${p.name || ""}</div>
          <div class="price">${p.price || 0}円</div>
          <div class="stock">在庫: ${p.stock ?? "-"}</div>
          ${p.desc ? `<div class="desc">${p.desc}</div>` : ""}

          <div class="qty-row">
            数量：
            <input type="number" min="0" step="1" value="${qty}" inputmode="numeric" />
          </div>
        </div>
      `;

      const input = card.querySelector('input[type="number"]');
      input.addEventListener("input", () => {
        setQty(p, input.value);
      });
      input.addEventListener("blur", () => {
        // 空欄などを整形
        input.value = getQty(p.id);
      });

      grid.appendChild(card);
    });

    // 初期状態のボタン判定
    toConfirmBtn.disabled = calcTotal(cart) <= 0;
  }

  // ②住所入力へ
  toConfirmBtn.addEventListener("click", () => {
    saveOrder({ items: cart }); // 念のため保存
    location.href = "/public/address.html";
  });

  // 起動
  (async () => {
    const products = await fetchProducts();
    if (!products.length) {
      grid.innerHTML = "商品がありません。";
      return;
    }
    renderProducts(products);
  })();
})();
