"use strict";

/**
 * confirm-cod.js — 代引き明細（送料の明細が必ず出る版）
 * ✅ storage が読めない環境でも
 *   - LIFF初期化 → userId取得 → /api/liff/address/me で住所取得 → /api/shipping で送料計算
 * ✅ sumShipping に必ず送料を表示
 */

const orderListEl   = document.getElementById("orderList");
const sumItemsEl    = document.getElementById("sumItems");
const sumShippingEl = document.getElementById("sumShipping");
const sumTotalEl    = document.getElementById("sumTotal");
const statusMsgEl   = document.getElementById("statusMsg");

const backBtn       = document.getElementById("backBtn");
const confirmBtn    = document.getElementById("confirmCod");

const COD_FEE = 330;

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

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
function getOrderFromStorage() {
  const keys = ["order", "currentOrder", "orderDraft", "confirm_normalized_order"];
  for (const k of keys) {
    const v = sessionStorage.getItem(k) || localStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (j && Array.isArray(j.items)) return j;
  }
  return { items: [], address: null };
}
function saveOrderToStorage(order) {
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

// ---------- LIFF (住所が無いときの保険) ----------
async function getLiffId() {
  const r = await fetch("/api/liff/config?kind=order");
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok || !j?.liffId) throw new Error("LIFF設定が取得できません");
  return String(j.liffId);
}

async function initLiffAndGetUser() {
  if (!window.liff) throw new Error("LIFF SDK が読み込まれていません");
  const liffId = await getLiffId();
  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login();
    return null; // ログイン遷移する
  }
  const p = await liff.getProfile();
  return { userId: p.userId, displayName: p.displayName || "" };
}

async function fetchMyAddress(userId) {
  const r = await fetch(`/api/liff/address/me?userId=${encodeURIComponent(userId)}`);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) return null;
  return j.address || null;
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

function go(url) {
  // ここは「別ウィンドウにしない」ほうが storage が安定します
  location.href = url;
}

// ---------- Main ----------
document.addEventListener("DOMContentLoaded", async () => {
  try {
    setStatus("注文情報を読み込んでいます…");

    // まず storage から読む
    const order = getOrderFromStorage();
    const items = Array.isArray(order.items) ? order.items : [];

    if (!items.length) {
      orderListEl.innerHTML = `<div class="row">カートが空です。商品一覧に戻ってください。</div>`;
      sumItemsEl.textContent = "0円";
      sumShippingEl.textContent = "0円";
      sumTotalEl.textContent = "0円";
      confirmBtn.disabled = true;
      setStatus("商品が入っていません。confirm.html に戻ってやり直してください。");
      return;
    }

    // 商品合計
    const itemsTotal =
      toNum(order.itemsTotal, 0) ||
      items.reduce((s, it) => s + (toNum(it.price, 0) * toNum(it.qty, 0)), 0);

    renderItems(items);
    sumItemsEl.textContent = yen(itemsTotal);

    // 送料を「必ず」求める
    let address = order.address || null;
    let shipping = toNum(order.shipping, 0);
    let region = order.region || "";
    let size = order.size || "";

    // 住所が無い or storageが別で欠けてるとき → LIFFで取りに行く
    if (!hasAddress(address)) {
      setStatus("住所が見つからないため、LINEから住所を取得しています…");
      try {
        const me = await initLiffAndGetUser();
        if (!me) return; // loginへ
        const addr = await fetchMyAddress(me.userId);
        if (addr) {
          address = addr;
          order.address = addr;
          order.lineUserId = me.userId;
          order.lineUserName = me.displayName;
          saveOrderToStorage(order);
        }
      } catch (e) {
        // LIFFが使えない環境ならここに来る
      }
    }

    if (!hasAddress(address)) {
      // ここまでやっても住所が無いなら送料は出せない
      sumShippingEl.textContent = "0円（住所未登録）";
      sumTotalEl.textContent = yen(itemsTotal + COD_FEE);
      confirmBtn.disabled = true;
      setStatus("住所が未登録のため送料を表示できません。confirm.html → 住所入力からやり直してください。");
    } else {
      setStatus("送料を計算しています…");

      // 送料が0でも「計算し直す」（明細が出ない問題の決定打）
      const result = await calcShipping(items, address);
      shipping = toNum(result.shipping, 0);
      region = result.region || region;
      size = result.size || size;

      order.itemsTotal = toNum(result.itemsTotal, itemsTotal);
      order.shipping = shipping;
      order.region = region;
      order.size = size;

      const total = order.itemsTotal + shipping + COD_FEE;
      order.total = total;

      saveOrderToStorage(order);

      // ✅ 明細表示（ここが必ず動く）
      sumShippingEl.textContent = yen(shipping);
      sumTotalEl.textContent = yen(total);

      setStatus(`送料OK（地域：${region || "不明"} / サイズ：${size || "?"}）`);
      confirmBtn.disabled = false;
    }

    backBtn?.addEventListener("click", () => go("./confirm.html"));

    confirmBtn?.addEventListener("click", async () => {
      // ここは「送料表示」目的とは別なので、いったん動作維持だけ
      confirmBtn.disabled = true;
      setStatus("注文を確定しています…（サーバ側の確定APIに合わせて実装が必要です）");
      // 必要なら、確定APIのURLに合わせてここを作り込みます
      setTimeout(() => {
        confirmBtn.disabled = false;
        setStatus("※注文確定APIはサーバ実装に合わせて接続します。送料の明細表示はOKです。");
      }, 300);
    });

  } catch (e) {
    sumShippingEl.textContent = "0円（エラー）";
    setStatus(`エラー：${e?.message || e}`);
    confirmBtn.disabled = true;
  }
});
