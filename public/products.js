// public/products.js
// /api/products のレスポンス
// { ok: true, products: [ { id, name, price, stock, desc, image }, ... ] }
// を使って商品一覧を描画し、confirm.html へ注文データを渡す

(async function () {
  const grid = document.getElementById("productGrid");
  const toConfirmBtn = document.getElementById("toConfirmBtn");

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

  const products = await fetchProducts();

  // ====== 商品カード描画 ======
  products.forEach(p => {
    const id    = p.id;
    const name  = p.name;
    const price = Number(p.price || 0);
    const stock = Number(p.stock || 0);
    const image = p.image || "";
    const desc  = p.desc  || "";

    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = id;
    card.dataset.name = name;
    card.dataset.price = String(price);

    card.innerHTML = `
      ${image ? `<img src="${image}" alt="${name}">` : ""}
      <div class="card-body">
        <div class="card-title">${name}</div>
        <div class="price">${price}円（税込）</div>
        <div class="stock">在庫：${stock}袋</div>
        ${desc ? `<div class="desc">${desc}</div>` : ""}
        <div class="qty-row">
          数量：
          <input
            type="number"
            min="0"
            max="${stock}"
            step="1"
            value="0"
            class="qty-input"
          >
          袋
        </div>
      </div>
    `;

    grid.appendChild(card);
  });

  // ====== ボタン活性/非活性制御 ======
  function updateButtonState() {
    const qtyInputs = document.querySelectorAll(".qty-input");
    let hasItem = false;
    qtyInputs.forEach(input => {
      const v = Number(input.value || "0");
      if (v > 0) hasItem = true;
    });
    toConfirmBtn.disabled = !hasItem;
  }

  document.querySelectorAll(".qty-input").forEach(input => {
    input.addEventListener("input", e => {
      const max = Number(e.target.max || "0");
      let v = Number(e.target.value || "0");
      if (v < 0) v = 0;
      if (max && v > max) v = max; // 在庫を超えないように
      e.target.value = v;
      updateButtonState();
    });
  });

  // ====== 「注文内容を確認する」押下時 ======
  toConfirmBtn.addEventListener("click", () => {
    const cards = document.querySelectorAll(".card");
    const orderItems = [];
    let total = 0;

    cards.forEach(card => {
      const qty = Number(card.querySelector(".qty-input").value || "0");
      if (qty > 0) {
        const id    = card.dataset.id;
        const name  = card.dataset.name;
        const price = Number(card.dataset.price);
        orderItems.push({ id, name, price, qty });
        total += price * qty;
      }
    });

    if (orderItems.length === 0) return;

    const order = { items: orderItems, total };

    // confirm.html で読むために保存
    sessionStorage.setItem("currentOrder", JSON.stringify(order));

    // 確認画面へ
    location.href = "confirm.html";
  });

})();
