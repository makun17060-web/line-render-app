// products.js — オンライン注文用 商品一覧（ミニアプリ）【修正版・丸ごと】
// 改善点：API返却の揺れ吸収 / HTML返却時の耐性 / DOM初期化の確実化 / idの型揺れ対策

(function () {
  "use strict";

  const grid = document.getElementById("productGrid");
  const cartSummaryEl = document.getElementById("cartSummary");
  const toAddressBtn = document.getElementById("toAddressBtn");
  const statusEl = document.getElementById("statusMsg");

  let products = [];
  let cart = {}; // { [idStr]: { id, name, price, qty } }

  function yen(n) {
    return Number(n || 0).toLocaleString("ja-JP") + "円";
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.style.color =
      kind === "ok" ? "#0a7b19" :
      kind === "err" ? "#d00" :
      "#d00";
  }

  function idKey(id) {
    return String(id ?? "");
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
        if (!it) return;
        const key = idKey(it.id);
        if (!key) return;

        const qty = Math.max(0, Number(it.qty) || 0);
        if (!qty) return;

        cart[key] = {
          id: key,
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
    const arr = Object.values(cart).filter((it) => (Number(it.qty) || 0) > 0);
    sessionStorage.setItem("cartItems", JSON.stringify(arr));
  }

  function getCartItemsArray() {
    return Object.values(cart).filter((it) => (Number(it.qty) || 0) > 0);
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
    const key = idKey(product.id);
    const qty = Math.max(0, Math.min(99, Number(newQty) || 0));

    if (!key) return;

    if (qty <= 0) {
      delete cart[key];
    } else {
      cart[key] = {
        id: key,
        name: product.name || "",
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

    const stockNum = Number(p.stock ?? 0);

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
    const key = idKey(p.id);
    const initialQty = cart[key]?.qty || 0;
    qtySpan.textContent = String(initialQty);

    const plusBtn = document.createElement("button");
    plusBtn.type = "button";
    plusBtn.textContent = "+";

    qtyRow.appendChild(minusBtn);
    qtyRow.appendChild(qtySpan);
    qtyRow.appendChild(plusBtn);
    card.appendChild(qtyRow);

    let currentQty = Number(initialQty) || 0;

    function applyQty(newQty) {
      const maxStock = Number.isFinite(stockNum) && stockNum >= 0 ? stockNum : 99;
      const next = Math.max(0, Math.min(maxStock, Number(newQty) || 0));
      if (next === currentQty) return;
      currentQty = next;
      qtySpan.textContent = String(currentQty);
      updateQty(p, currentQty);
    }

    minusBtn.addEventListener("click", () => applyQty(currentQty - 1));

    plusBtn.addEventListener("click", () => {
      if (stockNum <= 0) {
        setStatus("在庫切れのため追加できません。", "err");
        return;
      }
      applyQty(currentQty + 1);
    });

    if (stockNum <= 0) {
      plusBtn.disabled = true;
    }

    return card;
  }

  // ===== 商品一覧読み込み =====
  async function loadProducts() {
    if (!grid) {
      setStatus("画面の表示要素が見つかりません（productGrid）。HTML側のIDを確認してください。", "err");
      return;
    }

    try {
      setStatus("商品一覧を読み込んでいます…", "");

      const res = await fetch("/api/products", { cache: "no-store" });

      // 404/500でHTMLが返るケースを吸収
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      const rawText = await res.text();

      let data = {};
      if (ct.includes("application/json")) {
        try { data = JSON.parse(rawText); } catch { data = {}; }
      } else {
        // JSONじゃない（=だいたいHTML）→原因が分かるようにログ
        console.error("/api/products non-json response:", rawText.slice(0, 500));
        data = {};
      }

      if (!res.ok || !data.ok) {
        console.error("/api/products response:", { status: res.status, data, rawText: rawText.slice(0, 500) });
        setStatus("商品一覧の取得に失敗しました。時間をおいて再度お試しください。", "err");
        return;
      }

      // ✅ 返却形式の揺れ吸収
      // よくある候補：data.products / data.items / data.products.items
      const list =
        (Array.isArray(data.products) && data.products) ||
        (Array.isArray(data.items) && data.items) ||
        (data.products && Array.isArray(data.products.items) && data.products.items) ||
        [];

      // idを文字列に統一しておく
      products = list
        .map((p) => ({
          ...p,
          id: idKey(p?.id),
          price: Number(p?.price) || 0,
          stock: Number(p?.stock ?? 0),
        }))
        .filter((p) => p.id);

      if (!products.length) {
        grid.innerHTML = "<p>現在、オンライン注文できる商品がありません。</p>";
        renderCartSummary();
        setStatus("", "");
        return;
      }

      grid.innerHTML = "";
      products.forEach((p) => grid.appendChild(createProductCard(p)));

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

    saveCartToStorage();

    const itemsTotal = getItemsTotal();
    sessionStorage.setItem("itemsTotal", String(itemsTotal));

    setStatus("住所入力画面に移動します…", "ok");

    const params = new URLSearchParams(window.location.search.replace(/^\?/, ""));
    if (!params.has("from")) params.set("from", "miniapp");
    const qs = params.toString();
    window.location.href = "./liff-address.html" + (qs ? "?" + qs : "");
  }

  // ===== 初期化（1回だけ確実に）=====
  function init() {
    loadCartFromStorage();
    loadProducts();
    toAddressBtn?.addEventListener("click", handleToAddress);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
