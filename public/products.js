// products.js — オンライン注文用 商品一覧（ミニアプリ）

(function () {
  "use strict";

  const grid = document.getElementById("productGrid");
  const cartSummaryEl = document.getElementById("cartSummary");
  const toAddressBtn = document.getElementById("toAddressBtn");
  const statusEl = document.getElementById("statusMsg");

  let products = [];
  let cart = {}; // { [id]: { id, name, price, qty } }

  function yen(n) {
    return Number(n || 0).toLocaleString("ja-JP") + "円";
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.style.color =
      kind === "ok" ? "#0a7b19" :
      kind === "err" ? "#d00" :
      "#d00"; // エラー表示が多いので赤ベース
  }

  // ===== カート保存/読込 =====
  function loadCartFromStorage() {
    cart = {};
    try {
      const raw = sessionStorage.getItem("cartItems");
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      arr.forEach((it) => {
        if (!it || !it.id) return;
        const qty = Math.max(0, Number(it.qty) || 0);
        if (!qty) return;
        cart[it.id] = {
          id: it.id,
          name: it.name || "",
          price: Number(it.price) || 0,
          qty,
        };
      });
    } catch (e) {
      console.warn("cartItems parse error:", e);
      cart = {};
    }
  }

  function saveCartToStorage() {
    const arr = Object.values(cart).filter((it) => it.qty > 0);
    sessionStorage.setItem("cartItems", JSON.stringify(arr));
  }

  function getCartItemsArray() {
    return Object.values(cart).filter((it) => it.qty > 0);
  }

  function getItemsTotal() {
    return getCartItemsArray().reduce(
      (sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0),
      0
    );
  }

  // ===== カートサマリー表示 =====
  function renderCartSummary() {
    if (!cartSummaryEl) return;

    const items = getCartItemsArray();
    if (items.length === 0) {
      cartSummaryEl.textContent = "カートに商品は入っていません。";
      return;
    }

    const lines = [];
    lines.push("現在のカート内容：");
    items.forEach((it) => {
      const lineTotal = (Number(it.price) || 0) * (Number(it.qty) || 0);
      lines.push(`・${it.name} × ${it.qty} = ${yen(lineTotal)}`);
    });
    lines.push("");
    lines.push(`商品合計：${yen(getItemsTotal())}`);
    lines.push("※送料は住所入力後、自動計算されます。");

    cartSummaryEl.textContent = lines.join("\n");
  }

  // ===== 数量変更 =====
  function updateQty(product, newQty) {
    const qty = Math.max(0, Math.min(99, Number(newQty) || 0));

    if (qty <= 0) {
      delete cart[product.id];
    } else {
      cart[product.id] = {
        id: product.id,
        name: product.name,
        price: Number(product.price) || 0,
        qty,
      };
    }
    saveCartToStorage();
    renderCartSummary();
    setStatus("", "");
  }

  // ===== 商品カード生成 =====
  function createProductCard(p) {
    const card = document.createElement("div");
    card.className = "card";

    // 画像
    if (p.image) {
      const img = document.createElement("img");
      img.src = p.image;
      img.alt = p.name || "";
      card.appendChild(img);
    }

    // タイトル
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = p.name || "";
    card.appendChild(title);

    // 内容量
    if (p.volume) {
      const volume = document.createElement("div");
      volume.className = "card-volume";
      volume.textContent = p.volume;
      card.appendChild(volume);
    }

    // 説明
    if (p.desc) {
      const desc = document.createElement("div");
      desc.className = "card-desc";
      desc.textContent = p.desc;
      card.appendChild(desc);
    }

    // 価格
    const price = document.createElement("div");
    price.className = "card-price";
    price.textContent = yen(p.price || 0);
    card.appendChild(price);

    // 在庫表示
    const stock = document.createElement("div");
    stock.className = "card-stock";
    const stockNum = Number(p.stock ?? 0);
    if (stockNum <= 0) {
      stock.textContent = "在庫：0個（在庫切れ）";
    } else {
      stock.textContent = `在庫：${stockNum}個`;
    }
    card.appendChild(stock);

    // 数量操作
    const qtyRow = document.createElement("div");
    qtyRow.className = "qty-row";

    const minusBtn = document.createElement("button");
    minusBtn.type = "button";
    minusBtn.textContent = "−";

    const qtySpan = document.createElement("span");
    const initialQty = cart[p.id]?.qty || 0;
    qtySpan.textContent = initialQty;

    const plusBtn = document.createElement("button");
    plusBtn.type = "button";
    plusBtn.textContent = "+";

    qtyRow.appendChild(minusBtn);
    qtyRow.appendChild(qtySpan);
    qtyRow.appendChild(plusBtn);
    card.appendChild(qtyRow);

    // ボタンの動き
    let currentQty = initialQty;

    function applyQty(newQty) {
      const maxStock = typeof stockNum === "number" && stockNum >= 0 ? stockNum : 99;
      const next = Math.max(0, Math.min(maxStock, Number(newQty) || 0));
      if (next === currentQty) return;
      currentQty = next;
      qtySpan.textContent = currentQty;
      updateQty(p, currentQty);
    }

    minusBtn.addEventListener("click", () => {
      applyQty(currentQty - 1);
    });

    plusBtn.addEventListener("click", () => {
      if (stockNum <= 0) {
        setStatus("在庫切れのため追加できません。", "err");
        return;
      }
      applyQty(currentQty + 1);
    });

    // 在庫ゼロなら + ボタンを無効化
    if (stockNum <= 0) {
      plusBtn.disabled = true;
    }

    return card;
  }

  // ===== 商品一覧読み込み =====
  async function loadProducts() {
    try {
      setStatus("商品一覧を読み込んでいます…", "");
      const res = await fetch("/api/products");
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        console.error("/api/products response:", data);
        setStatus("商品一覧の取得に失敗しました。時間をおいて再度お試しください。", "err");
        return;
      }

      products = Array.isArray(data.products) ? data.products : [];

      if (!products.length) {
        grid.innerHTML = "<p>現在、オンライン注文できる商品がありません。</p>";
        setStatus("", "");
        return;
      }

      // 画面クリア
      grid.innerHTML = "";

      // カード生成
      products.forEach((p) => {
        const card = createProductCard(p);
        grid.appendChild(card);
      });

      renderCartSummary();
      setStatus("", "");
    } catch (e) {
      console.error("/api/products error:", e);
      setStatus("商品一覧の読み込み中にエラーが発生しました。", "err");
    }
  }

  // ===== 住所入力画面へ遷移 =====
  function handleToAddress() {
    const items = getCartItemsArray();
    if (items.length === 0) {
      setStatus("カートに商品が入っていません。商品を選んでからお進みください。", "err");
      return;
    }

    // 念のため保存
    saveCartToStorage();

    // 商品合計だけ別途保存しておいてもよい（confirmで使うなら）
    const itemsTotal = getItemsTotal();
    sessionStorage.setItem("itemsTotal", String(itemsTotal));

    setStatus("住所入力画面に移動します…", "ok");

    // 既存クエリを維持しつつ from=miniapp を足す
    const currentSearch = window.location.search || "";
    const params = new URLSearchParams(currentSearch.replace(/^\?/, ""));
    if (!params.has("from")) {
      params.set("from", "miniapp");
    }
    const qs = params.toString();
    const nextUrl = "./liff-address.html" + (qs ? "?" + qs : "");
    window.location.href = nextUrl;
  }

  // ===== 初期化 =====
  document.addEventListener("DOMContentLoaded", () => {
    loadCartFromStorage();
    loadProducts();

    if (toAddressBtn) {
      toAddressBtn.addEventListener("click", handleToAddress);
    }
  });
})();
