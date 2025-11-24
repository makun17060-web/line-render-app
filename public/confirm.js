// public/confirm.js
// ③ 最終確認画面（修正版・丸ごと）
// - currentOrder.items を表示
// - LIFFで userId を取得
// - order.address が無ければ /api/liff/address/me から取得
// - /api/shipping で送料計算
// - currentOrder を最新化して pay.html へ

(async function () {
  const $ = (id) => document.getElementById(id);

  const itemsArea = $("itemsArea");
  const addressArea = $("addressArea");
  const itemsTotalEl = $("itemsTotalPrice");
  const shippingEl = $("shippingPrice");
  const finalTotalEl = $("finalTotalPrice");
  const backBtn = $("backToAddressBtn");
  const toPayBtn = $("toPayBtn");

  function yen(n){ return `${Number(n||0).toLocaleString("ja-JP")}円`; }
  function escapeHtml(s){
    return String(s||"")
      .replaceAll("&","&amp;").replaceAll("<","&lt;")
      .replaceAll(">","&gt;").replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  function readOrder() {
    const keys = ["currentOrder", "confirmOrder", "cart", "orderDraft"];
    for (const k of keys) {
      try {
        const v = sessionStorage.getItem(k) || localStorage.getItem(k);
        if (!v) continue;
        const o = JSON.parse(v);
        if (o && Array.isArray(o.items)) return o;
      } catch {}
    }
    return {};
  }

  const order = readOrder();
  const items = Array.isArray(order.items) ? order.items : [];

  if (!items.length) {
    itemsArea.innerHTML =
      `<div class="empty">注文データが見つかりません。①商品選択からやり直してください。</div>`;
    addressArea.innerHTML = `<div class="empty">住所データがありません。</div>`;
    toPayBtn.disabled = true;
    return;
  }

  // --- items 表示 ---
  itemsArea.innerHTML = items.map(it => {
    const lineTotal = (it.price||0) * (it.qty||0);
    return `
      <div class="row">
        <div class="name">${escapeHtml(it.name)}</div>
        <div class="qty">×${it.qty}</div>
        <div class="price">${yen(lineTotal)}</div>
      </div>
    `;
  }).join("");

  const itemsTotal = items.reduce((s,it)=>s+(it.price||0)*(it.qty||0),0);
  itemsTotalEl.textContent = yen(itemsTotal);

  // --- LIFF init + userId 取得 ---
  let lineUserId = "";

  async function initLiff() {
    try {
      const confRes = await fetch("/api/liff/config", { cache:"no-store" });
      const conf = await confRes.json();
      const liffId = (conf?.liffId || "").trim();
      if (!liffId || !window.liff) return false;

      await liff.init({ liffId });

      if (!liff.isLoggedIn()) {
        liff.login();
        return false;
      }

      const prof = await liff.getProfile();
      lineUserId = prof.userId || "";
      order.lineUserId = lineUserId;
      order.lineUserName = prof.displayName || "";
      sessionStorage.setItem("currentOrder", JSON.stringify(order));
      return true;
    } catch (e) {
      console.log("LIFF error:", e);
      return false;
    }
  }

  await initLiff();

  // --- 住所取得 ---
  async function loadAddress() {
    // すでに order に住所があればそれ採用
    if (order.address) return order.address;

    if (!lineUserId) return null;

    try {
      const res = await fetch(`/api/liff/address/me?userId=${encodeURIComponent(lineUserId)}`, { cache:"no-store" });
      const data = await res.json();
      return data?.address || null;
    } catch {
      return null;
    }
  }

  const address = await loadAddress();

  if (!address) {
    addressArea.innerHTML =
      `<div class="empty">住所が未登録です。②で入力してください。</div>`;
    toPayBtn.disabled = true;
  } else {
    addressArea.innerHTML = `
      <div style="font-size:14px;line-height:1.6;">
        〒${escapeHtml(address.postal || "")}<br>
        ${escapeHtml(address.prefecture || "")}${escapeHtml(address.city || "")}<br>
        ${escapeHtml(address.address1 || "")} ${escapeHtml(address.address2 || "")}<br>
        氏名：${escapeHtml(address.name || "")}<br>
        TEL：${escapeHtml(address.phone || "")}
      </div>
    `;
    order.address = address;
    sessionStorage.setItem("currentOrder", JSON.stringify(order));
  }

  // --- 送料計算 ---
  let shipping = 0;
  let region = "";

  try {
    const res = await fetch("/api/shipping", {
      method:"POST",
      headers:{ "Content-Type": "application/json" },
      body: JSON.stringify({ items, address })
    });
    const data = await res.json();
    if (data?.ok) {
      shipping = Number(data.shipping||0);
      region = data.region||"";
    }
  } catch {}

  shippingEl.textContent = region ? `${yen(shipping)}（${region}）` : yen(shipping);
  const finalTotal = itemsTotal + shipping;
  finalTotalEl.textContent = yen(finalTotal);

  order.itemsTotal = itemsTotal;
  order.shipping = shipping;
  order.region = region;
  order.finalTotal = finalTotal;

  sessionStorage.setItem("currentOrder", JSON.stringify(order));

  // --- ボタン ---
  // ②の画面に戻す（あなたの住所入力ページURLに合わせて変えてOK）
  backBtn.addEventListener("click", () => {
    history.back(); // ← 迷ったらこれが一番安全
  });

  toPayBtn.addEventListener("click", () => {
    location.href = "/public/pay.html";
  });

})();
