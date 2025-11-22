// public/products.js
// ① 商品選択画面
// - /api/products を読み込み
// - 数量カートを管理
// - sessionStorage.currentOrder に items[] 形式で保存
//   → confirm.js / pay.js が確実に拾える形

(async function () {
  const $ = (id) => document.getElementById(id);

  const grid = $("productGrid");
  const toConfirmBtn = $("toConfirmBtn");
  const clearCartBtn = $("clearCartBtn");
  const cartTotalEl = $("cartTotal");

  // -----------------------------
  // 0) ユーティリティ
  // -----------------------------
  const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;
  const escapeHtml = (s) =>
    String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  // -----------------------------
  // 1) 商品取得
  // -----------------------------
  async function fetchProducts() {
    try {
      const res = await fetch("/api/products", { cache: "no-store" });
      const data = await res.json();
      if (!data || !data.ok || !Array.isArray(data.products)) return [];
      return data.products;
    } catch (e) {
      console.error("products fetch error:", e);
      return [];
    }
  }

  const products = await fetchProducts();

  if (!products.length) {
    grid.innerHTML = `<div class="empty">商品が見つかりませんでした。</div>`;
    return;
  }

  // -----------------------------
  // 2) カート（数量）管理
  // -----------------------------
  const cart = new Map(); // id -> { id,name,price,qty,image }

  function calcTotal() {
    let total = 0;
    for (const it of cart.values()) {
      total += (it.price || 0) * (it.qty || 0);
    }
    return total;
  }

  function updateFooter() {
    const total = calcTotal();
    cartTotalEl.textContent = yen(total);
    toConfirmBtn.disabled = total <= 0;
    clearCartBtn.disabled = total <= 0;
  }

  function setQty(p, qty) {
    const q = Math.max(0, Math.min(99, Number(qty) || 0));
    if (q <= 0) {
      cart.delete(p.id);
    } else {
      cart.set(p.id, {
        id: p.id,
        name: p.name,
        price: Number(p.price || 0),
        qty: q,
        image: p.image || ""
      });
    }
    updateFooter();
    render(); // 数量表示更新
  }

  // -----------------------------
  // 3) 描画
  // -----------------------------
  function render() {
    grid.innerHTML = products.map(p => {
      const inCart = cart.get(p.id);
      const qty = inCart?.qty || 0;

      return `
        <div class="card" data-id="${escapeHtml(p.id)}">
          <div class="img">
            ${p.image
              ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}">`
              : `画像なし`}
          </div>
          <div class="body">
            <div class="name">${escapeHtml(p.name)}</div>
            <div class="desc">${escapeHtml(p.desc || "")}</div>
            <div class="price">${yen(p.price)}</div>
            <div class="stock">在庫：${Number(p.stock ?? 0)}個</div>

            <div class="qty-row">
              <button class="qty-btn minus">-</button>
              <div class="qty">${qty}</div>
              <button class="qty-btn plus">+</button>
            </div>
          </div>
        </div>
      `;
    }).join("");

    // ボタンイベント
    grid.querySelectorAll(".card").forEach(card => {
      const id = card.getAttribute("data-id");
      const p = products.find(x => x.id === id);
      if (!p) return;

      card.querySelector(".minus").addEventListener("click", () => {
        const now = cart.get(id)?.qty || 0;
        setQty(p, now - 1);
      });
      card.querySelector(".plus").addEventListener("click", () => {
        const now = cart.get(id)?.qty || 0;
        // 在庫以上は増やさない
        const stock = Number(p.stock ?? 0);
        if (stock > 0 && now + 1 > stock) return;
        setQty(p, now + 1);
      });
    });
  }

  render();
  updateFooter();

  // -----------------------------
  // 4) 最終確認へ：保存して遷移
  // -----------------------------
  toConfirmBtn.addEventListener("click", () => {
    const items = Array.from(cart.values());

    // confirm.js / pay.js が拾う形に統一
    const order = {
      items,               // ★必須
      method: "delivery",  // 仮（confirm側で上書きOK）
      address: null,       // 住所はLIFF入力で入る想定
      itemsTotal: calcTotal(),
      shipping: 0,
      finalTotal: calcTotal()
    };

    // ★これが一番大事（pay.jsは currentOrder を探す）
    sessionStorage.setItem("currentOrder", JSON.stringify(order));
    // 保険で互換キーも入れる
    sessionStorage.setItem("cart", JSON.stringify(order));

    location.href = "/public/confirm.html";
  });

  // -----------------------------
  // 5) カートを空にする
  // -----------------------------
  clearCartBtn.addEventListener("click", () => {
    cart.clear();
    updateFooter();
    render();
    sessionStorage.removeItem("currentOrder");
    sessionStorage.removeItem("cart");
  });

})();
