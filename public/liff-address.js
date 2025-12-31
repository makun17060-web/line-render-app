"use strict";

/**
 * liff-address.js — 住所入力（オンライン注文）
 * - products.js が保存した order を読み込み
 * - フォームへ反映
 * - 保存すると order.address を更新して、複数キーへ同期保存
 * - 可能なら /api/shipping で送料試算して order.shipping に保存（confirm側が楽）
 * - 「住所を保存して確認画面へ」→ confirm.html に遷移
 * - 「確認画面に戻る」→ confirm.html に戻る（保存なし）
 *
 * ★重要：サーバは /api/shipping を持っている前提（server-line.js にある）
 */

const $ = (id) => document.getElementById(id);

const postalEl = $("postal");
const prefEl = $("prefecture");
const cityEl = $("city");
const address1El = $("address1");
const address2El = $("address2");
const nameEl = $("name");
const phoneEl = $("phone");

const saveBtn = $("saveBtn");
const backBtn = $("backBtn");
const statusMsg = $("statusMsg");

// ★確認画面のファイル名（あなたの環境で違うならここだけ変更）
const CONFIRM_PAGE = "./confirm.html";

// products.js と揃える
const ORDER_KEYS = ["order", "currentOrder", "orderDraft", "confirm_normalized_order"];

function setStatus(msg = "") {
  if (statusMsg) statusMsg.textContent = msg;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function toNum(x, fallback = 0) {
  const n = Number(String(x ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function loadOrder() {
  // sessionStorage 優先
  for (const k of ORDER_KEYS) {
    const v = sessionStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (j && typeof j === "object") return j;
  }
  // localStorage フォールバック
  const v2 = localStorage.getItem("order");
  const j2 = v2 ? safeJsonParse(v2) : null;
  if (j2 && typeof j2 === "object") return j2;

  return { items: [], itemsTotal: 0, address: null };
}

function saveOrderAll(order) {
  const txt = JSON.stringify(order);
  for (const k of ORDER_KEYS) sessionStorage.setItem(k, txt);
  localStorage.setItem("order", txt);
}

function getFormAddress() {
  return {
    postal: (postalEl?.value || "").trim(),
    prefecture: (prefEl?.value || "").trim(),
    city: (cityEl?.value || "").trim(),
    address1: (address1El?.value || "").trim(),
    address2: (address2El?.value || "").trim(),
    name: (nameEl?.value || "").trim(),
    phone: (phoneEl?.value || "").trim(),
  };
}

function fillFormFromAddress(a) {
  if (!a) return;
  if (postalEl) postalEl.value = a.postal || "";
  if (prefEl) prefEl.value = a.prefecture || "";
  if (cityEl) cityEl.value = a.city || "";
  if (address1El) address1El.value = a.address1 || "";
  if (address2El) address2El.value = a.address2 || "";
  if (nameEl) nameEl.value = a.name || "";
  if (phoneEl) phoneEl.value = a.phone || "";
}

function validateAddress(a) {
  if (!a.postal) return "郵便番号を入力してください。";
  if (!a.prefecture) return "都道府県を入力してください。";
  if (!a.city) return "市区町村を入力してください。";
  if (!a.address1) return "番地・建物名を入力してください。";
  if (!a.name) return "お名前を入力してください。";
  if (!a.phone) return "電話番号を入力してください。";
  return "";
}

// 送料試算（server-line.js の /api/shipping を利用）
async function calcShipping(order, address) {
  const items = Array.isArray(order.items) ? order.items.map(it => ({
    id: it.id,
    name: it.name,
    qty: toNum(it.qty, 0),
    price: toNum(it.price, 0),
  })) : [];

  if (!items.length) return { ok: false, error: "items empty" };
  if (!address?.prefecture) return { ok: false, error: "prefecture missing" };

  const r = await fetch("/api/shipping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items, prefecture: address.prefecture }),
  });

  const t = await r.text().catch(() => "");
  let obj;
  try { obj = JSON.parse(t); } catch { obj = { ok: false, error: t }; }

  if (!r.ok || !obj?.ok) return { ok: false, error: obj?.error || "shipping api error" };
  // { ok:true, size, region, fee }
  return obj;
}

async function tryInitLiffAndAttachUserId(order) {
  // LIFFが使えない環境でも住所入力は動かす
  try {
    // LIFF_ID を HTML 側に埋め込む運用なら window.LIFF_ID を使う
    const LIFF_ID = String(window.LIFF_ID || "").trim();
    if (!LIFF_ID) return;

    await liff.init({ liffId: LIFF_ID });
    if (!liff.isInClient()) return;
    if (!liff.isLoggedIn()) { liff.login(); return; }

    const prof = await liff.getProfile();
    const userId = prof?.userId || "";
    if (userId) {
      order.userId = userId;

      // 任意ログ（server-line.js に /api/liff/log がある場合）
      try {
        await fetch("/api/liff/log", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId, event: "address_open", meta: { page: "liff-address" } }),
        });
      } catch {}
    }
  } catch {
    // ignore
  }
}

(async function main() {
  try {
    setStatus("");

    const order = loadOrder();

    // 既存住所があればフォームに反映
    if (order.address) fillFormFromAddress(order.address);

    // LIFFがあれば userId を紐づけ（必須ではない）
    tryInitLiffAndAttachUserId(order).finally(() => {
      saveOrderAll(order);
    });

    // 保存して確認へ
    saveBtn?.addEventListener("click", async () => {
      setStatus("");
      saveBtn.disabled = true;

      try {
        const a = getFormAddress();
        const err = validateAddress(a);
        if (err) { setStatus(err); return; }

        const o2 = loadOrder();
        o2.address = a;

        // 送料も保存（confirm側が楽）
        const ship = await calcShipping(o2, a);
        if (ship.ok) {
          o2.shipping = { fee: ship.fee, size: ship.size, region: ship.region };
        }

        saveOrderAll(o2);

        setStatus("保存しました。確認画面へ移動します…");
        location.href = CONFIRM_PAGE;
      } catch (e) {
        setStatus("保存に失敗しました: " + (e?.message || e));
      } finally {
        saveBtn.disabled = false;
      }
    });

    // 戻る（保存なしで confirm へ）
    backBtn?.addEventListener("click", () => {
      location.href = CONFIRM_PAGE;
    });

  } catch (e) {
    setStatus("エラー: " + (e?.message || e));
    if (saveBtn) saveBtn.disabled = true;
  }
})();
