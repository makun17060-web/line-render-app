// public/products.js — 管理画面で設定した商品画像＆情報を使って商品一覧を描画
// 前提：server.js 側に /api/products などの商品一覧APIがある想定

(async function () {
  const grid = document.getElementById("productGrid");
  const toConfirmBtn = document.getElementById("toConfirmBtn");

  // ====== 商品一覧取得 ======
  async function fetchProducts() {
    try {
      const res = await fetch("/api/products", { cache: "no-store" });
      const data = await res.json();

      // data が配列 or { products: [...] } 両対応にしておく
      const list = Array.isArray(data) ? data :
                   Array.isArray(data.products) ? data.products : [];

      return list;
    } catch (e) {
      console.error("商品一覧の取得に失敗:", e);
      return [];
    }
  }

  const products = await fetchProducts();

  // ====== 商品カード描画 ======
  products.forEach(p => {
    // サーバー側のフィールド名に合わせてここを調整してください
    const id    = p.id    || p.productId || p.code  || "";
    const name  = p.name  || p.title     || "商品名未設定";
    const price = Number(p.price || p.unitPrice || 0);
    const image = p.image || p.imageUrl  || "";
    const desc  = p.description || "";

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
        ${desc ? `<div class="desc">${desc}</div>` : ""}
        <div class="qty-row">
          数量：
          <input type="number" min="0" step="1" value="0" class="qty-input">
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
    input.addEventListener("input", updateButtonState);
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
