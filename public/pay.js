// /public/pay.js
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

  function yen(n){ return `${Number(n||0).toLocaleString("ja-JP")}円`; }
  function escapeHtml(s){
    return String(s||"")
      .replaceAll("&","&amp;").replaceAll("<","&lt;")
      .replaceAll(">","&gt;").replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  function readOrder() {
    try { return JSON.parse(sessionStorage.getItem("currentOrder") || "{}"); }
    catch { return {}; }
  }

  const order = readOrder();
  const items = Array.isArray(order.items) ? order.items : [];

  if (!items.length) {
    itemsArea.innerHTML = `<div class="empty">注文データが見つかりません。③からやり直してください。</div>`;
    statusMsg.textContent = "注文データなし";
    return;
  }

  // render items
  itemsArea.innerHTML = items.map(it=>{
    const lineTotal = (it.price||0)*(it.qty||0);
    return `
      <div class="row">
        <div class="name">${escapeHtml(it.name)}</div>
        <div class="qty">×${it.qty}</div>
        <div class="price">${yen(lineTotal)}</div>
      </div>
    `;
  }).join("");

  const itemsTotal = Number(order.itemsTotal || items.reduce((s,it)=>s+(it.price||0)*(it.qty||0),0));
  const shipping   = Number(order.shipping || 0);
  const finalTotal = Number(order.finalTotal || (itemsTotal + shipping));

  elItemsTotal.textContent = yen(itemsTotal);
  elShipping.textContent   = order.region ? `${yen(shipping)}（${order.region}）` : yen(shipping);
  elFinalTotal.textContent = yen(finalTotal);

  // LIFF profile
  let lineUserId = order.lineUserId || "";
  let lineUserName = order.lineUserName || "";

  async function initLiffProfile() {
    try {
      const confRes = await fetch("/api/liff/config", { cache:"no-store" });
      const conf = await confRes.json();
      const liffId = (conf?.liffId || "").trim();
      if (!liffId) return;

      await liff.init({ liffId });

      if (!liff.isLoggedIn()) {
        liff.login();
        return;
      }

      const prof = await liff.getProfile();
      lineUserId = prof.userId || "";
      lineUserName = prof.displayName || "";
    } catch {}
  }

  await initLiffProfile();

  if (!lineUserId) {
    statusMsg.textContent = "LINEアプリ内で開いてください。";
    payBtn.disabled = true;
    return;
  }

  payBtn.disabled = false;

  async function startPay() {
    payBtn.disabled = true;
    statusMsg.textContent = "決済ページを準備しています…";

    const payload = {
      ...order,
      items,
      itemsTotal,
      shipping,
      total: finalTotal,
      finalTotal,
      lineUserId,
      lineUserName
    };

    try {
      const res = await fetch("/api/pay", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data?.ok || !data.redirectUrl) throw new Error(data?.error || "pay_failed");

      sessionStorage.setItem("currentOrder", JSON.stringify(payload));

      statusMsg.textContent = "イプシロン決済へ移動します…";
      location.href = data.redirectUrl;

    } catch (e) {
      console.log(e);
      statusMsg.textContent =
        "決済の開始に失敗しました。\n通信状況をご確認ください。\n" +
        (e?.message ? `詳細: ${e.message}` : "");
      payBtn.disabled = false;
    }
  }

  payBtn.addEventListener("click", startPay);
  backBtn.addEventListener("click", ()=>history.back());
})();
