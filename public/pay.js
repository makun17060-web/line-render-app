// /public/pay.js
// ④決済画面（修正版・丸ごと）
// - sessionStorage の注文情報を表示
// - /api/shipping で送料算出
// - /api/pay に lineUserId / lineUserName を入れて投げる（memo1 へ入る）
// - redirectUrl を受け取って Epsilon 決済へ遷移

(async function () {
  const $ = (id) => document.getElementById(id);

  const itemsArea    = $("payItemsArea");
  const elItemsTotal = $("payItemsTotal");
  const elShipping   = $("payShipping");
  const elFinalTotal = $("payFinalTotal");
  const statusMsg    = $("payStatusMsg");
  const payBtn       = $("payBtn");
  const backBtn      = $("backToConfirmBtn");

  payBtn.disabled = true;

  // -----------------------------
  // 1) 注文情報を取り出す
  // -----------------------------
  function readOrderFromStorage() {
    // 期待キー（どれか入っていればOKにする）
    const keys = ["currentOrder", "confirmOrder", "cart", "orderDraft"];
    for (const k of keys) {
      try {
        const v = sessionStorage.getItem(k) || localStorage.getItem(k);
        if (!v) continue;
        const obj = JSON.parse(v);
        if (obj && (obj.items || obj.cartItems || obj.products)) return obj;
      } catch {}
    }
    return null;
  }

  // items の標準化
  function normalizeItems(order) {
    const raw =
      order?.items ||
      order?.cartItems ||
      order?.products ||
      [];
    if (!Array.isArray(raw)) return [];

    return raw
      .map(it => ({
        id: String(it.id || it.productId || "").trim(),
        name: String(it.name || it.productName || "").trim() || "商品",
        price: Number(it.price || it.unitPrice || 0),
        qty: Number(it.qty || it.quantity || 0),
        image: it.image || ""
      }))
      .filter(it => it.id && it.qty > 0);
  }

  const order = readOrderFromStorage();
  const items = normalizeItems(order);

  if (!items.length) {
    itemsArea.innerHTML =
      `<div class="empty">注文データが見つかりません。<br>③の最終確認からやり直してください。</div>`;
    statusMsg.textContent = "注文データなし";
    return;
  }

  // 受取方法/住所を引き継ぎ（無ければ空）
  const method  = (order?.method || order?.receiveMethod || "").trim(); // delivery / pickup
  const address = order?.address || order?.shippingAddress || null;

  // -----------------------------
  // 2) 商品リスト表示
  // -----------------------------
  function renderItems(list) {
    itemsArea.innerHTML = list.map(it => {
      const lineTotal = it.price * it.qty;
      return `
        <div class="row">
          <div class="name">${escapeHtml(it.name)}</div>
          <div class="qty">×${it.qty}</div>
          <div class="price">${yen(lineTotal)}</div>
        </div>
      `;
    }).join("");
  }

  function yen(n) {
    return `${Number(n || 0).toLocaleString("ja-JP")}円`;
  }
  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  renderItems(items);

  const itemsTotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  elItemsTotal.textContent = yen(itemsTotal);

  // -----------------------------
  // 3) 送料計算
  // -----------------------------
  let shipping = 0;
  let region = "";

  async function calcShipping() {
    // 店頭受取なら送料0
    if (method === "pickup") {
      shipping = 0;
      region = "-";
      return;
    }

    // 住所が無いと送料判定できないので0表示
    if (!address) {
      shipping = 0;
      region = "";
      return;
    }

    try {
      const res = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, address })
      });
      const data = await res.json();
      if (data && data.ok) {
        shipping = Number(data.shipping || 0);
        region = data.region || "";
      } else {
        shipping = 0;
        region = "";
      }
    } catch {
      shipping = 0;
      region = "";
    }
  }

  await calcShipping();

  elShipping.textContent =
    method === "pickup"
      ? "0円（店頭受取）"
      : (region ? `${yen(shipping)}（${region}）` : yen(shipping));

  const finalTotal = itemsTotal + shipping;
  elFinalTotal.textContent = yen(finalTotal);

  // -----------------------------
  // 4) LIFF 初期化して profile 取得
  // -----------------------------
  let lineUserId = "";
  let lineUserName = "";

  async function initLiffAndProfile() {
    try {
      if (!window.liff) return;

      // サーバから LIFF ID を取得（server.js に /api/liff/config がある前提）
      const confRes = await fetch("/api/liff/config", { cache: "no-store" });
      const conf = await confRes.json();
      const liffId = (conf?.liffId || "").trim();
      if (!liffId) return;

      await liff.init({ liffId });

      if (!liff.isLoggedIn()) {
        liff.login();
        return;
      }

      const profile = await liff.getProfile();
      lineUserId = profile.userId || "";
      lineUserName = profile.displayName || "";
    } catch (e) {
      console.log("LIFF init/profile error:", e);
    }
  }

  // ★ ここは1回だけ！
  await initLiffAndProfile();

  // LINEアプリ外で開かれた場合は userId が取れないので止める
  if (!lineUserId) {
    statusMsg.textContent =
      "LINEアプリ内で開いてください。\n" +
      "（ブラウザではユーザーIDが取得できません）";
    payBtn.disabled = true;
    return;
  }

  // ここまで来たら決済ボタン有効化
  payBtn.disabled = false;
  statusMsg.textContent = "";

  // -----------------------------
  // 5) 決済開始 → /api/pay
  // -----------------------------
  async function startPay() {
    payBtn.disabled = true;
    statusMsg.textContent = "決済ページを準備しています…";

    const payload = {
      items,
      total: finalTotal,
      lineUserId,      // ★ memo1 に入る最重要
      lineUserName,
      method,
      address,
      shipping,
      itemsTotal,
      region
    };

    try {
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!data || !data.ok || !data.redirectUrl) {
        throw new Error(data?.error || "pay_failed");
      }

      // 念のため保存（成功画面などで使いたい場合）
      sessionStorage.setItem("currentOrder", JSON.stringify(payload));

      statusMsg.textContent = "イプシロン決済へ移動します…";
      location.href = data.redirectUrl;

    } catch (e) {
      console.log(e);
      statusMsg.textContent =
        "決済の開始に失敗しました。\n" +
        "通信状況をご確認の上、もう一度お試しください。\n" +
        (e?.message ? `\n詳細: ${e.message}` : "");
      payBtn.disabled = false;
    }
  }

  payBtn.addEventListener("click", startPay);

  // 戻る
  backBtn.addEventListener("click", () => history.back());

})();
