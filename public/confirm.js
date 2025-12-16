// confirm.js — 注文内容確認・支払方法選択（送料はサーバー正本）【修正版・丸ごと】

(function () {
  "use strict";

  const orderListEl = document.getElementById("orderList");
  const sumItemsEl = document.getElementById("sumItems");
  const sumShippingEl = document.getElementById("sumShipping");
  const sumCodEl = document.getElementById("sumCod");
  const sumTotalCodEl = document.getElementById("sumTotalCod");
  const statusEl = document.getElementById("statusMsg");

  const cardBtn = document.getElementById("cardBtn");
  const codBtn = document.getElementById("codBtn");
  const backBtn = document.getElementById("backBtn");

  function yen(n) {
    return Number(n || 0).toLocaleString("ja-JP") + "円";
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.style.color =
      kind === "ok" ? "#0a7b19" :
      kind === "err" ? "#d00" :
      "#555";
  }

  function readCartItems() {
    // products.js が保存している形式：sessionStorage.cartItems = [{id,name,price,qty}, ...]
    try {
      const raw = sessionStorage.getItem("cartItems");
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .map(it => ({
          id: it.id,
          name: it.name || "",
          price: Number(it.price) || 0,
          qty: Math.max(0, Number(it.qty) || 0),
        }))
        .filter(it => it.id && it.qty > 0);
    } catch {
      return [];
    }
  }

  function readRegion() {
    // address.html 側で保存している想定キー
    // 例：sessionStorage.setItem("shippingRegion","関東")
    return sessionStorage.getItem("shippingRegion") || "";
  }

  function itemsTotal(items) {
    return items.reduce((s, it) => s + (it.price * it.qty), 0);
  }

  function renderOrderList(items) {
    if (!orderListEl) return;
    if (!items.length) {
      orderListEl.innerHTML = "<p>注文内容がありません。商品選択からやり直してください。</p>";
      return;
    }

    orderListEl.innerHTML = "";
    items.forEach(it => {
      const row = document.createElement("div");
      row.className = "order-row";
      row.textContent = `・${it.name} × ${it.qty} = ${yen(it.price * it.qty)}`;
      orderListEl.appendChild(row);
    });
  }

  async function quoteShipping(region, items) {
    // server-line.js 側の正本API
    const payload = {
      region,
      items: items.map(it => ({ productId: it.id, qty: it.qty })),
    };

    const r = await fetch("/api/shipping/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      const err = data?.error || "QUOTE_FAILED";
      throw new Error(err);
    }
    // data: { ok:true, region, size, shippingFee, codFee }
    return data;
  }

  function goBackToAddress() {
    // あなたのフロー：products.js では ./liff-address.html へ行くので、ここも同じに戻す
    const params = new URLSearchParams(location.search);
    if (!params.has("from")) params.set("from", "miniapp");
    location.href = "./liff-address.html" + (params.toString() ? "?" + params.toString() : "");
  }

  function goToDetail(payment, shippingFee, codFee) {
    // 次の画面（明細）に渡したい値を保存
    // ※あなたの既存明細画面が読むキーに合わせて必要なら変えてください
    sessionStorage.setItem("shippingFee", String(shippingFee));
    sessionStorage.setItem("codFee", String(codFee));
    sessionStorage.setItem("paymentMethod", payment); // "card" or "cod"

    // 既存の遷移先があるならそこへ
    // 例：card-detail.html / cod-detail.html
    if (payment === "card") {
      location.href = "./card-detail.html";
    } else {
      location.href = "./cod-detail.html";
    }
  }

  async function init() {
    setStatus("", "");

    // ボタン一旦無効（計算完了まで）
    if (cardBtn) cardBtn.disabled = true;
    if (codBtn) codBtn.disabled = true;

    const items = readCartItems();
    const region = readRegion();

    renderOrderList(items);

    if (!items.length) {
      setStatus("商品が選択されていません。商品一覧からやり直してください。", "err");
      if (backBtn) backBtn.textContent = "商品一覧に戻る";
      if (backBtn) backBtn.onclick = () => location.href = "./products.html";
      return;
    }
    if (!region) {
      setStatus("お届け先の地域情報がありません。住所入力からやり直してください。", "err");
      if (backBtn) backBtn.onclick = goBackToAddress;
      return;
    }

    // 商品合計
    const itemsSum = itemsTotal(items);
    if (sumItemsEl) sumItemsEl.textContent = yen(itemsSum);

    try {
      setStatus("送料を計算しています…", "");

      // ★サーバー正本で送料見積もり（60/80判定含む）
      const q = await quoteShipping(region, items);

      // 表示
      if (sumShippingEl) sumShippingEl.textContent = `${yen(q.shippingFee)}（${q.size}サイズ）`;
      if (sumCodEl) sumCodEl.textContent = `${yen(q.codFee)}（代引きの場合のみ）`;

      const totalCod = itemsSum + q.shippingFee + q.codFee;
      if (sumTotalCodEl) sumTotalCodEl.textContent = yen(totalCod);

      // 明細画面で使うため保存
      sessionStorage.setItem("shippingSize", String(q.size));
      sessionStorage.setItem("shippingFee", String(q.shippingFee));
      sessionStorage.setItem("codFee", String(q.codFee));
      sessionStorage.setItem("shippingRegion", q.region);

      // ボタン復帰
      if (cardBtn) cardBtn.disabled = false;
      if (codBtn) codBtn.disabled = false;

      setStatus("お支払い方法を選択してください。", "ok");

      // ボタンの遷移
      if (cardBtn) {
        cardBtn.onclick = () => goToDetail("card", q.shippingFee, q.codFee);
      }
      if (codBtn) {
        codBtn.onclick = () => goToDetail("cod", q.shippingFee, q.codFee);
      }
    } catch (e) {
      console.error("shipping quote error:", e);
      if (sumShippingEl) sumShippingEl.textContent = "計算できません";
      setStatus(
        "送料の計算に失敗しました。\n住所入力に戻ってやり直してください。",
        "err"
      );
      if (backBtn) backBtn.onclick = goBackToAddress;
      return;
    }

    if (backBtn) backBtn.onclick = goBackToAddress;
  }

  document.addEventListener("DOMContentLoaded", init);
})();
