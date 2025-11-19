async function loadProducts() {
  const grid = document.getElementById("productGrid");
  grid.innerHTML = "読み込み中...";

  try {
    const res = await fetch("/api/products");
    const data = await res.json();
    if (!data.ok) {
      grid.innerHTML = "商品を読み込めませんでした。";
      return;
    }

    const products = data.products;

    grid.innerHTML = "";

    products.forEach(p => {
      const card = document.createElement("div");
      card.className = "card";

      card.innerHTML = `
        <img src="${p.image}" alt="${p.name}">
        <div class="card-body">
          <div class="card-title">${p.name}</div>
          <div class="price">¥${p.price}</div>
          <div class="stock">在庫：${p.stock}</div>
          <div class="desc">${p.desc}</div>
        </div>
        <div class="footer">
          <a href="#" class="btn">購入</a>
        </div>
      `;
      grid.appendChild(card);
    });

  } catch (e) {
    console.error(e);
    grid.innerHTML = "読み込みエラー";
  }
}

loadProducts();
