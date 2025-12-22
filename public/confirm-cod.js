"use strict";

/**
 * confirm-cod.js — 代金引換 明細（丸ごと版）
 * ✅ 目的
 * - order(items/address) を storage から確実に取得
 * - 送料が未計算なら /api/shipping で計算
 * - 明細に「送料」を必ず表示（sumShipping）
 * - 合計(sumTotal) を (商品合計 + 送料 + 代引き手数料) で表示
 * - 「代引きで注文を確定する」押下でサーバへ注文送信（複数エンドポイントを順に試す）
 */

const orderListEl   = document.getElementById("orderList");
const sumItemsEl    = document.getElementById("sumItems");
const sumShippingEl = document.getElementById("sumShipping");
const sumTotalEl    = document.getElementById("sumTotal");
const statusMsgEl   = document.getElementById("statusMsg");

const backBtn       = document.getElementById("backBtn");
const confirmBtn    = document.getElementById("confirmCod");

const COD_FEE = 330;

// ---------- Utils ----------
function yen(n) {
  const x = Number(n || 0);
  return `${x.toLocaleString("ja-JP")}円`;
}
function setStatus(msg) {
  if (statusMsgEl) statusMsgEl.textContent = msg || "";
}
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function toStr(x) { return String(x ?? "").trim(); }
function toNum(x, fallback = 0) {
  const n = Number(String(x ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function hasAddress(a) {
  if (!a) return false;
  const pref = a.prefecture || a.pref || "";
  const city = a.city || "";
  const addr1 = a.address1 || a.addr1 || "";
  const postal = a.postal || a.zip || "";
  return toStr(pref) && toStr(city) && toStr(addr1) && toStr(postal);
}

// ---------- Storage ----------
function getOrder() {
  const keys = ["order", "currentOrder", "orderDraft", "confirm_normalized_order"];
  for (const k of keys) {
    const v = sessionStorage.getItem(k) || localStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (j && Array.isArray(j.items)) return j;
  }
  return { items: [], address: null };
}

function saveOrder(order) {
  const s = JSON.stringify(order);
  sessionStorage.setItem("order", s);
  sessionStorage.setItem("currentOrder", s);
  sessionStorage.setItem("orderDraft", s);
  sessionStorage.setItem("confirm_normalized_order", s);
  localStorage.setItem("order", s);
}

// ---------- API ----------
async function calcShipping(items, address) {
  const r = await fetch("/api/shipping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, address }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(j?.error || "shipping_error");
  return j; // {ok, itemsTotal, region, size, shipping, finalTotal}
}

async function postOrderCOD(order) {
  // いまサーバ実装がどれか不明でも動くように「順番に試す」
  const payload = {
    paymentMethod: "cod",
    items: order.items || [],
    address: order.address || null,
    itemsTotal: toNum(order.itemsTotal, 0),
    shipping: toNum(order.shipping, 0),
    codFee: COD_FEE,
    total: toNum(order.total, 0),
    region: order.region || "",
    size: order.size || "",
    // LINE情報があれば同梱
    lineUserId: order.lineUserId || "",
    lineUserName: order.lineUserName || "",
    memberCode: order.memberCode || "",
    addressCode: order.addressCode || "",
    clientAt: new Date().toISOString(),
  };

  const endpoints = [
    "/api/order/cod",          // もし作ってある
    "/api/order/confirm-cod",  // もし作ってある
    "/api/order/complete",     // 既存の「注文完了」を流用してるケース
    "/api/order/complete-cod", // もし作ってある
  ];

  let lastErr = null;

  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && (j?.ok === true || j?.success === true)) {
        return { ok: true, url, res: j };
      }
      // サーバが「そのURLは無い」場合はHTML返しになることがある
      // → okでも jsonが壊れる/okでない/ok:false なら次へ
      lastErr = new Error(j?.error || `failed:${url}`);
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("order_post_failed");
}

// ---------- Render ----------
function renderItems(items) {
  orderListEl.innerHTML = items
    .map((it) => {
      const name = it.name || it.id || "商品";
      const qty = toNum(it.qty, 0);
      const sub = toNum(it.price, 0) * qty;
      return `<div class="row">${escapeHtml(name)} ×${qty} = ${yen(sub)}</div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function go(url) {
  // 通常遷移
  try { location.href = url; } catch {}
  // LIFF内での遷移補助（保険）
  if (window.liff && typeof window.liff.openWindow === "function") {
    try {
      window.liff.openWindow({
        url: new URL(url, location.href).toString(),
        external: false
      });
    } catch {}
  }
}

// ---------- Main ----------
document.addEventListener("DOMContentLoaded", async () => {
  const order = getOrder();
  const items = Array.isArray(order.items) ? order.items : [];

  if (!items.length) {
    orderListEl.innerHTML = `<div class="row">カートが空です。商品一覧に戻ってください。</div>`;
    sumItemsEl.textContent = "0円";
    sumShippingEl.textContent = "0円";
    sumTotalEl.textContent = "0円";
    confirmBtn.disabled = true;
    setStatus("商品が入っていません。");
    return;
  }

  // 商品合計
  const itemsTotal =
    toNum(order.itemsTotal, 0) ||
    items.reduce((s, it) => s + (toNum(it.price, 0) * toNum(it.qty, 0)), 0);

  renderItems(items);
  sumItemsEl.textContent = yen(itemsTotal);

  // 送料（明細に必ず出す）
  let shipping = toNum(order.shipping, 0);
  let region = order.region || "";
  let size = order.size || "";

  try {
    setStatus("送料を確認しています…");

    const address = order.address || null;
    if (!hasAddress(address)) {
      // 住所が無い → 送料計算不可
      sumShippingEl.textContent = "0円（住所未登録）";
      const total = itemsTotal + 0 + COD_FEE;
      sumTotalEl.textContent = yen(total);

      // orderにも入れておく（明細の一貫性）
      order.itemsTotal = itemsTotal;
      order.shipping = 0;
      order.total = total;
      saveOrder(order);

      setStatus("住所が未登録のため送料を計算できません。住所入力へ戻って保存してください。");
      confirmBtn.disabled = true;
    } else {
      // 既に送料が入っていなければ計算
      if (!shipping) {
        const result = await calcShipping(items, address);
        shipping = toNum(result.shipping, 0);
        region = result.region || region;
        size = result.size || size;

        // 保存して次画面でも使えるように
        order.itemsTotal = toNum(result.itemsTotal, itemsTotal);
        order.shipping = shipping;
        order.region = region;
        order.size = size;
      } else {
        // 送料が既に入っている場合も itemsTotal を揃える
        order.itemsTotal = itemsTotal;
      }

      sumShippingEl.textContent = yen(shipping);
      const total = order.itemsTotal + shipping + COD_FEE;
      sumTotalEl.textContent = yen(total);

      order.total = total;
      saveOrder(order);

      setStatus(`送料OK（地域：${region || "不明"} / サイズ：${size || "?"}）`);
      confirmBtn.disabled = false;
    }
  } catch (e) {
    // 送料計算エラーでも明細は崩さない
    sumShippingEl.textContent = "0円（計算エラー）";
    const total = itemsTotal + 0 + COD_FEE;
    sumTotalEl.textContent = yen(total);

    order.itemsTotal = itemsTotal;
    order.shipping = 0;
    order.total = total;
    saveOrder(order);

    setStatus(`送料計算に失敗しました：${e?.message || e}`);
    confirmBtn.disabled = true;
  }

  // 戻る：confirm.htmlへ
  backBtn?.addEventListener("click", () => go("./confirm.html"));

  // 注文確定（代引き）
  confirmBtn?.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    try {
      setStatus("代引き注文を確定しています…");

      const fresh = getOrder(); // 念のため最新を読む
      if (!fresh?.items?.length) throw new Error("items_missing");

      // 送料が0で住所があるのに「本当は必要」な場合もあるのでガード
      if (hasAddress(fresh.address) && toNum(fresh.shipping, 0) === 0) {
        // confirm.htmlで計算済みのはずだが念のため再計算
        const result = await calcShipping(fresh.items, fresh.address);
        fresh.itemsTotal = toNum(result.itemsTotal, fresh.itemsTotal || 0);
        fresh.shipping = toNum(result.shipping, 0);
        fresh.region = result.region || fresh.region || "";
        fresh.size = result.size || fresh.size || "";
        fresh.total = toNum(fresh.itemsTotal, 0) + toNum(fresh.shipping, 0) + COD_FEE;
        saveOrder(fresh);

        sumShippingEl.textContent = yen(fresh.shipping);
        sumTotalEl.textContent = yen(fresh.total);
      }

      const posted = await postOrderCOD(fresh);

      setStatus(`注文を確定しました。\n（送信先：${posted.url}）`);

      // 完了画面があるならここを変更
      // location.href = "./thanks.html";
      // とりあえず confirm.html に戻す（運用に合わせて変更OK）
      setTimeout(() => go("./confirm.html"), 700);
    } catch (e) {
      setStatus(`注文確定に失敗しました：${e?.message || e}\n※サーバ側の注文受付APIのURLが違う可能性があります。`);
      confirmBtn.disabled = false;
    }
  });
});
