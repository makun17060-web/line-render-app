// products.js（修正版）
// - /api/products の volume を表示（.card-volume）
// - 既存UI（画像/名前/説明/価格/在庫/数量）を維持
// ※ サーバ側 /api/products は { ok:true, products:[ {id,name,price,stock,desc,volume,image} ] } を返す前提

(() => {
  "use strict";

  const grid = document.getElementById("productGrid");
  const cartSummary = document.getElementById("cartSummary");
  const toAddressBtn = document.getElementById("toAddressBtn");
  const statusMsg = document.getElementById("statusMsg");

  const yen = (n) => Number(n || 0).toLocaleString("ja-JP") + "円";

  // カート：{ [productId]: qty }
  const cart = {};

  function setStatus(text = "") {
    statusMsg.textContent = text;
  }

  function sanitize(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function fetchProducts() {
    setStatus("");
    const res = await fetch("/api/products", { cache: "no-store" });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`商品取得に失敗しました (${res.status}) ${t}`);
    }
    const j = await res.json();
    const products = Array.isArray(j.products) ? j.products : [];
    return products;
  }

  function updateCartSummary(products) {
    const lines = [];
    let totalQty = 0;
    let itemsTotal = 0;

    for (const p of products) {
      const q = Number(cart[p.id] || 0);
      if (q <= 0) continue;
      totalQty += q;
      itemsTotal += Number(p.price || 0) * q;
      lines.push(`・${p.name} x ${q} = ${yen(Number(p.price || 0) * q)}`);
    }

    if (!lines.length) {
      cartSummary.textContent = "カートに商品は入っていません。";
      toAddressBtn.disabled = true;
      return;
    }

    cartSummary.textContent =
      `カート内容（合計 ${totalQty} 点）\n` +
      lines.join("\n") +
      `\n\n商品合計：${yen(itemsTotal)}\n` +
      "※送料・手数料は住所入力後に計算されます。";

    toAddressBtn.disabled = false;
  }

  function changeQty(productId, delta, stock) {
    const cur = Number(cart[productId] || 0);
    let next = cur + delta;

    if (next < 0) next = 0;
    // 在庫が数値で入っている場合だけ上限をかける
    const st = Number(stock);
    if (!Number.isNaN(st) && st >= 0) {
      if (next > st) next = st;
    }

    if (next === 0) delete cart[productId];
    else cart[productId] = next;
  }

  function render(products) {
    grid.innerHTML = "";

    for (const p of products) {
      const card = document.createElement("div");
      card.className = "card";

      const imgUrl = p.image || "";
      if (imgUrl) {
        const img = document.createElement("img");
        img.src = imgUrl;
        img.alt = p.name || "";
        card.appendChild(img);
      }

      const title = document.createElement("div");
      title.className = "card-title";
      title.textContent = p.name || "";
      card.appendChild(title);

      const desc = document.createElement("div");
      desc.className = "card-desc";
      desc.textContent = p.desc || "";
      card.appendChild(desc);

      // ✅ 内容量（volume）を表示
      // - volume が空なら表示しない（余計な空行を作らない）
      if (p.volume && String(p.volume).trim()) {
        const vol = document.createElement("div");
        vol.className = "card-volume";
        vol.textContent = `内容量：${p.volume}`;
        card.appendChild(vol);
      }

      const price = document.createElement("div");
      price.className = "card-price";
      price.textContent = `価格：${yen(p.price)}`;
      card.appendChild(price);

      const stock = document.createElement("div");
      stock.className = "card-stock";
      const st = p.stock ?? 0;
      stock.textContent = `在庫：${st} 個`;
      card.appendChild(stock);

      const qtyRow = document.createElement("div");
      qtyRow.className = "qty-row";

      const minus = document.createElement("button");
      minus.type = "button";
      minus.textContent = "−";

      const qtySpan = document.createElement("span");
      qtySpan.textContent = String(cart[p.id] || 0);

      const plus = document.createElement("button");
      plus.type = "button";
      plus.textContent = "＋";

      minus.addEventListener("click", () => {
        changeQty(p.id, -1, p.stock);
        qtySpan.textContent = String(cart[p.id] || 0);
        updateCartSummary(products);
      });

      plus.addEventListener("click", () => {
        changeQty(p.id, +1, p.stock);
        qtySpan.textContent = String(cart[p.id] || 0);
        updateCartSummary(products);
      });

      qtyRow.appendChild(minus);
      qtyRow.appendChild(qtySpan);
      qtyRow.appendChild(plus);
      card.appendChild(qtyRow);

      grid.appendChild(card);
    }

    updateCartSummary(products);
  }

  function gotoAddress(products) {
    // 既存の遷移仕様に合わせて、クエリにカートを載せる例
    // もし既に別の仕様があるなら、ここだけあなたの既存ロジックに合わせてください。
    const items = products
      .map((p) => ({ id: p.id, qty: Number(cart[p.id] || 0) }))
      .filter((x) => x.qty > 0);

    if (!items.length) return;

    // 例：address.html に items を渡す（URL長くなる場合はlocalStorageに逃がす）
    localStorage.setItem("iso_cart_items", JSON.stringify(items));

    // 例の遷移先（あなたの実ファイル名に合わせて変更）
    location.href = "./address.html";
  }

  // 起動
  (async () => {
    try {
      toAddressBtn.disabled = true;
      const products = await fetchProducts();
      render(products);

      toAddressBtn.addEventListener("click", () => gotoAddress(products));
    } catch (e) {
      console.error(e);
      setStatus(e.message || "エラーが発生しました。");
    }
  })();
})();
