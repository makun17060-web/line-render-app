// public/products.js
// /api/products で商品一覧を描画し、カートを sessionStorage に保存して address.html へ進む

(async function () {
  const grid = document.getElementById("productGrid");
  const toConfirmBtn = document.getElementById("toConfirmBtn");

  // ===== 共通：sessionStorage =====
  const STATE_KEY = "miniapp_state";

  function loadState() {
    try {
      return JSON.parse(sessionStorage.getItem(STATE_KEY) || "{}");
    } catch {
      return {};
    }
  }
  function saveState(partial) {
    const cur = loadState();
    const next = { ...cur, ...partial };
    sessionStorage.setItem(STATE_KEY, JSON.stringify(next));
    return next;
  }

  function yen(n) {
    return (Number(n) || 0).toLocaleString("ja-JP") + "円";
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

  // 既存state（戻ってきた時に数量復元）
  let st = loadState();
  if (!st.cart) st.cart = {}; // { id: qty }

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
    card.dataset.stock = String(stock);

    // ★ 前回の入力があれば復元
    const savedQty = Number(st.cart[id] || 0);

    card.innerHTML = `
      ${image ? `<img src="${image}" alt="${name}">` : ""}
      <div class="card-body">
        <div class="card-title">${name}</div>
        <div class="price">${yen(price)}（税込）</div>
        <div class="stock">在庫：${stock}袋</div>
        ${desc ? `<div class="desc">${desc}</div>` : ""}
        <div class="qty-row">
          数量：
          <input
            type="number"
            min="0"
            max="${stock}"
            step="1"
            value="${savedQty}"
            class="qty-input"
          >
          袋
        </div>
      </div>
    `;

    grid.appendChild(card);
  });

  // ====== ボタン活性/非活性制御 ======
  function updateButtonStateAndSaveCart() {
    const qtyInputs = document.querySelectorAll(".qty-input");

    let hasItem = false;
    const cart = {};

    qtyInputs.forEach(input => {
      const card = input.closest(".card");
      const id = card.dataset.id;
      const max = Number(input.max || "0");

      let v = Number(input.value || "0");
      if (v < 0) v = 0;
      if (max && v > max) v = max;
      input.value = v;

      if (v > 0) {
        hasItem = true;
        cart[id] = v;
      }
    });

    toConfirmBtn.disabled = !hasItem;

    // ★ cart を保存（confirm 済みフラグはリセット）
    saveState({ cart, confirmed: false });
    st = loadState();
  }

  document.querySelectorAll(".qty-input").forEach(input => {
    input.addEventListener("input", updateButtonStateAndSaveCart);
  });

  // 初期状態のボタン反映
  updateButtonStateAndSaveCart();

  // ====== 「注文内容を確認する」押下時 ======
  toConfirmBtn.addEventListener("click", () => {
    const cards = document.querySelectorAll(".card");
    const orderItems = [];
    let itemsTotal = 0;

    cards.forEach(card => {
      const qty = Number(card.querySelector(".qty-input").value || "0");
      if (qty > 0) {
        const id    = card.dataset.id;
        const name  = card.dataset.name;
        const price = Number(card.dataset.price);
        orderItems.push({ id, name, price, qty });
        itemsTotal += price * qty;
      }
    });

    if (orderItems.length === 0) return;

    // ★ items と商品合計を保存（送料は address/confirm 側で計算）
    saveState({
      cart: Object.fromEntries(orderItems.map(it => [it.id, it.qty])),
      items: orderItems,
      itemsTotal,
      confirmed: false
    });

    // ★ 次は住所ページへ
    location.href = "/public/address.html";
  });

})();
