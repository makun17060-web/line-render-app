// public/products.js
// /api/products から商品一覧を取得して表示し、
// カート → liff-address.html → confirm.html の流れ。

(async function () {
  const grid = document.getElementById("productGrid");
  const cartSummary = document.getElementById("cartSummary");
  const btnAddress = document.getElementById("toAddressBtn");
  const statusMsg = document.getElementById("statusMsg");

  // ====== 商品一覧取得 ======
  async function fetchProducts() {
    try {
      const res = await fetch("/api/products", { cache: "no-store" });
      const data = await res.json();

      if (!data || !data.ok || !Array.isArray(data.products)) {
        console.error("想定外のレスポンス形式:", data);
        statusMsg.textContent = "商品一覧の取得に失敗しました。時間をおいて再度お試しください。";
        return [];
      }
      return data.products;
    } catch (e) {
      console.error("商品一覧の取得に失敗:", e);
      statusMsg.textContent = "商品一覧の取得に失敗しました。通信環境をご確認ください。";
      return [];
    }
  }

  const products = await fetchProducts();

  // カートオブジェクト { productId: { id, name, price, qty } }
  const cart = {};

  function formatYen(n) {
    return Number(n || 0).toLocaleString("ja-JP") + "円";
  }

  function updateCartSummary() {
    const items = Object.values(cart);
    if (items.length === 0) {
      cartSummary.textContent = "カートに商品は入っていません。";
      return;
    }
    let totalQty = 0;
    let totalAmount = 0;
    const lines = items.map(it => {
      const sub = (Number(it.price) || 0) * (Number(it.qty) || 0);
      totalQty += it.qty;
      totalAmount += sub;
      return `・${it.name} × ${it.qty}個 = ${formatYen(sub)}`;
    });

    lines.push("");
    lines.push(`合計数量：${totalQty}個`);
    lines.push(`商品合計：${formatYen(totalAmount)}`);
    cartSummary.textContent = lines.join("\n");
  }

  function setQty(p, qty) {
    const q = Math.max(0, Math.min(99, qty | 0));
    if (q <= 0) {
      delete cart[p.id];
    } else {
      cart[p.id] = {
        id: p.id,
        name: p.name,
        price: p.price,
        qty: q,
      };
    }
    updateCartSummary();
  }

  // ====== 商品カード描画 ======
  products.forEach(p => {
    const card = document.createElement("div");
    card.className = "card";

    // 画像
    if (p.image) {
      const img = document.createElement("img");
      img.src = p.image;
      img.alt = p.name;
      card.appendChild(img);
    }

    // 商品名
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = p.name;
    card.appendChild(title);

    // 説明文
    if (p.desc) {
      const desc = document.createElement("div");
      desc.className = "card-desc";
      desc.textContent = p.desc;
      card.appendChild(desc);
    }

    // ★ 内容量（content）
    if (p.content) {
      const content = document.createElement("div");
      content.className = "card-content";
      content.textContent = `内容量：${p.content}`;
      card.appendChild(content);
    }

    // 価格
    const price = document.createElement("div");
    price.className = "card-price";
    price.textContent = `価格：${formatYen(p.price)}`;
    card.appendChild(price);

    // 在庫
    const stock = document.createElement("div");
    stock.className = "card-stock";
    stock.textContent = `在庫：${p.stock ?? 0}個`;
    card.appendChild(stock);

    // 数量 +- ボタン
    const qtyRow = document.createElement("div");
    qtyRow.className = "qty-row";

    const btnMinus = document.createElement("button");
    btnMinus.textContent = "−";

    const qtySpan = document.createElement("span");
    qtySpan.textContent = "0";

    const btnPlus = document.createElement("button");
    btnPlus.textContent = "+";

    btnMinus.onclick = () => {
      const cur = Number(qtySpan.textContent) || 0;
      const next = Math.max(0, cur - 1);
      qtySpan.textContent = String(next);
      setQty(p, next);
    };

    btnPlus.onclick = () => {
      const cur = Number(qtySpan.textContent) || 0;
      const next = Math.min(99, cur + 1);
      qtySpan.textContent = String(next);
      setQty(p, next);
    };

    qtyRow.appendChild(btnMinus);
    qtyRow.appendChild(qtySpan);
    qtyRow.appendChild(btnPlus);
    card.appendChild(qtyRow);

    grid.appendChild(card);
  });

  updateCartSummary();

  // ====== 住所入力へ進む ======
  btnAddress.onclick = () => {
    const items = Object.values(cart);
    if (items.length === 0) {
      alert("商品が選択されていません。");
      return;
    }

    const order = { items };

    try {
      sessionStorage.setItem("currentOrder", JSON.stringify(order));
    } catch (e) {
      console.error("sessionStorage 保存エラー:", e);
    }

    // LIFF住所入力へ
    location.href = "/public/liff-address.html";
  };

})();
