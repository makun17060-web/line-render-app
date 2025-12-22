"use strict";

/**
 * liff-address.js — 住所入力（オンライン注文）
 * 目的：
 * - 住所をサーバへ保存（/api/liff/address）
 * - カート（商品）＋住所を「確認画面が必ず読めるキー」に保存して、confirm.htmlへ遷移
 *
 * 想定：
 * - カート情報は、前画面で localStorage/sessionStorage に入っている（キーが色々でも拾う）
 * - /api/liff/config が使える（このサーバ構成だとOK）
 * - confirm.html は同じ /public 配下（例：/public/confirm.html）
 */

// ===== DOM =====
const el = (id) => document.getElementById(id);
const statusMsg = el("statusMsg");

function setStatus(msg) {
  if (statusMsg) statusMsg.textContent = msg || "";
}

// ===== Utils =====
function toStr(x) { return String(x ?? "").trim(); }
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function normalizePostal(s) {
  const t = toStr(s).replace(/[^\d]/g, "");
  if (t.length === 7) return `${t.slice(0, 3)}-${t.slice(3)}`;
  return toStr(s);
}
function normalizePhone(s) {
  // 表示はそのままでもOKだが、余計な空白は削る
  return toStr(s).replace(/\s+/g, "");
}

function toNum(x, fallback = 0) {
  const n = Number(String(x ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : fallback;
}

// ===== Cart / Order load (前画面の保存キーがバラバラでも拾う) =====
function loadOrderFromAnyStorage() {
  const candidates = [
    // ありがち
    "order",
    "orderDraft",
    "currentOrder",
    "cart",
    "cartItems",
    "items",
    // 磯屋系
    "isoya_order",
    "isoya_cart",
    "iso_order",
    "iso_cart",
    // 以前のページが使ってそう
    "checkout",
    "checkoutDraft",
  ];

  // sessionStorage 優先
  for (const k of candidates) {
    const v = sessionStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (j) return { where: "sessionStorage", key: k, data: j };
  }
  // localStorage
  for (const k of candidates) {
    const v = localStorage.getItem(k);
    if (!v) continue;
    const j = safeJsonParse(v);
    if (j) return { where: "localStorage", key: k, data: j };
  }
  return { where: null, key: null, data: null };
}

function normalizeItems(raw) {
  let items = null;

  if (Array.isArray(raw)) items = raw;
  else if (raw && Array.isArray(raw.items)) items = raw.items;
  else if (raw && Array.isArray(raw.cartItems)) items = raw.cartItems;
  else if (raw && Array.isArray(raw.products)) items = raw.products;

  if (!Array.isArray(items)) return [];

  return items
    .map((it) => ({
      id: toStr(it.id ?? it.productId ?? ""),
      name: toStr(it.name ?? it.productName ?? it.title ?? "商品"),
      price: toNum(it.price ?? it.unitPrice ?? it.amount ?? 0, 0),
      qty: toNum(it.qty ?? it.quantity ?? it.count ?? 0, 0),
    }))
    .filter((it) => it.qty > 0);
}

function saveOrderForConfirm(items, address, meta = {}) {
  // ✅ confirm.js 丸ごと版が確実に拾うキーへ保存（複数）
  const payload = {
    items,
    address,
    ...meta,
  };

  sessionStorage.setItem("order", JSON.stringify(payload));
  sessionStorage.setItem("currentOrder", JSON.stringify(payload));
  sessionStorage.setItem("orderDraft", JSON.stringify(payload));
  sessionStorage.setItem("confirm_normalized_order", JSON.stringify(payload)); // confirm.jsでも使える

  // 念のため localStorage にも（環境でセッション切れがある場合）
  localStorage.setItem("order", JSON.stringify(payload));
}

// ===== LIFF / API =====
async function getLiffId() {
  // できればサーバの /api/liff/config から取得（kind=order）
  const r = await fetch("/api/liff/config?kind=order");
  const j = await r.json();
  if (!r.ok || !j?.ok || !j?.liffId) throw new Error("LIFF設定が取得できません");
  return String(j.liffId);
}

async function initLiff() {
  const liffId = await getLiffId();
  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login();
    return null; // loginで遷移するのでここで止まる
  }
  const profile = await liff.getProfile();
  return { userId: profile.userId, displayName: profile.displayName };
}

async function apiGetMyAddress(userId) {
  try {
    const r = await fetch(`/api/liff/address/me?userId=${encodeURIComponent(userId)}`);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) return null;
    return j.address || null;
  } catch {
    return null;
  }
}

async function apiSaveAddress(userId, address) {
  const r = await fetch("/api/liff/address", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, address }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(j?.error || "住所の保存に失敗しました");
  return j; // memberCode / addressCode など返る
}

// ===== Form =====
function readForm() {
  const address = {
    postal: normalizePostal(el("postal")?.value),
    prefecture: toStr(el("prefecture")?.value),
    city: toStr(el("city")?.value),
    address1: toStr(el("address1")?.value),
    address2: toStr(el("address2")?.value),
    name: toStr(el("name")?.value),
    phone: normalizePhone(el("phone")?.value),
  };
  return address;
}

function fillForm(addr) {
  if (!addr) return;
  if (el("postal")) el("postal").value = addr.postal || "";
  if (el("prefecture")) el("prefecture").value = addr.prefecture || "";
  if (el("city")) el("city").value = addr.city || "";
  if (el("address1")) el("address1").value = addr.address1 || "";
  if (el("address2")) el("address2").value = addr.address2 || "";
  if (el("name")) el("name").value = addr.name || "";
  if (el("phone")) el("phone").value = addr.phone || "";
}

function validateAddress(a) {
  const required = ["postal", "prefecture", "city", "address1", "name", "phone"];
  const missing = required.filter((k) => !toStr(a[k]));
  if (missing.length) return { ok: false, missing };
  // 郵便番号ざっくり
  const zipDigits = toStr(a.postal).replace(/[^\d]/g, "");
  if (zipDigits.length !== 7) return { ok: false, missing: ["postal"] };
  return { ok: true, missing: [] };
}

// ===== Main =====
(async function main() {
  const saveBtn = el("saveBtn");
  const backBtn = el("backBtn");

  try {
    setStatus("LIFF初期化中...");
    const me = await initLiff();
    if (!me) return;

    // 住所の既存データがあればフォームへ反映
    setStatus("住所データ確認中...");
    const prev = await apiGetMyAddress(me.userId);
    if (prev) fillForm(prev);

    // いまのカート（商品）を確認（ここが “商品合計が0になる” の根本対策）
    const loaded = loadOrderFromAnyStorage();
    const items = normalizeItems(loaded.data);
    if (!items.length) {
      setStatus("⚠️ カート（商品データ）が見つかりません。\n商品一覧ページに戻って商品を選び直してください。");
    } else {
      const itemsTotal = items.reduce((s, it) => s + (toNum(it.price) * toNum(it.qty)), 0);
      setStatus(`カート読込OK：${items.length}件 / 商品合計 ${itemsTotal.toLocaleString("ja-JP")}円\n住所を入力して保存してください。`);
    }

    // 保存ボタン
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        try {
          const address = readForm();
          const v = validateAddress(address);
          if (!v.ok) {
            setStatus("未入力があります。必須項目を確認してください。");
            saveBtn.disabled = false;
            return;
          }

          setStatus("住所を保存しています...");
          const saved = await apiSaveAddress(me.userId, address);

          // カートを再取得（直前に変更があっても確実に拾う）
          const loaded2 = loadOrderFromAnyStorage();
          const items2 = normalizeItems(loaded2.data);

          // ✅ 確認画面が必ず読める形で保存
          saveOrderForConfirm(items2, address, {
            lineUserId: me.userId,
            lineUserName: me.displayName || "",
            memberCode: saved.memberCode || "",
            addressCode: saved.addressCode || "",
            savedAt: new Date().toISOString(),
          });

          setStatus("保存しました。確認画面へ移動します...");

          // confirm.html へ（ファイル名が違うならここを変更）
          location.href = "./confirm.html";
        } catch (e) {
          setStatus(`保存に失敗しました：${e?.message || e}`);
          saveBtn.disabled = false;
        }
      });
    }

    // 戻るボタン
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        // “確認画面に戻る” と書いてあるので confirm.html へ戻す
        location.href = "./confirm.html";
      });
    }
  } catch (e) {
    setStatus(`初期化に失敗：${e?.message || e}`);
  }
})();
