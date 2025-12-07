// liff-address.js — オンライン注文用 住所入力（ミニアプリ用）

let currentUserId = "";
let currentUserName = ""; // ✅ 追加：表示名も保持

const statusEl = document.getElementById("statusMsg");
const saveBtn = document.getElementById("saveBtn");
const backBtn = document.getElementById("backBtn");

function setStatus(msg, kind) {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
  statusEl.style.color =
    kind === "ok" ? "#0a7b19" :
    kind === "err" ? "#d00" :
    "#555";
}

function getVal(id) {
  return (document.getElementById(id)?.value || "").trim();
}

function fillFormFromAddress(a) {
  if (!a) return;
  if (a.postal)     document.getElementById("postal").value     = a.postal;
  if (a.prefecture) document.getElementById("prefecture").value = a.prefecture;
  if (a.city)       document.getElementById("city").value       = a.city;
  if (a.address1)   document.getElementById("address1").value   = a.address1;
  if (a.address2)   document.getElementById("address2").value   = a.address2;
  if (a.name)       document.getElementById("name").value       = a.name;
  if (a.phone)      document.getElementById("phone").value      = a.phone;
}

// 住所入力画面 初期化
async function initLiffAddress() {
  try {
    setStatus("初期化中です…", "");

    // サーバーから LIFF ID を取得
    const cfgRes = await fetch("/api/liff/config");
    const cfg = await cfgRes.json();
    const liffId = cfg.liffId;
    if (!liffId) {
      setStatus("LIFF設定が取得できませんでした。", "err");
      return;
    }

    await liff.init({ liffId });

    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }

    const prof = await liff.getProfile();
    currentUserId   = prof.userId || "";
    currentUserName = prof.displayName || "";      // ✅ 追加
    // ✅ confirm側でも使えるように一応グローバルにも残しておく
    window._lineUserId   = currentUserId;
    window._lineUserName = currentUserName;

    if (!currentUserId) {
      setStatus("LINEユーザー情報が取得できませんでした。", "err");
      return;
    }

    // すでに登録済みの住所があれば読み込む
    try {
      const meRes = await fetch(
        "/api/liff/address/me?userId=" + encodeURIComponent(currentUserId)
      );
      const me = await meRes.json();
      if (me && me.ok && me.address) {
        fillFormFromAddress(me.address);
        setStatus(
          "登録済みの住所を読み込みました。必要であれば修正して保存してください。",
          "ok"
        );
      } else {
        setStatus(
          "お届け先を入力して「住所を保存して確認画面へ」を押してください。",
          ""
        );
      }
    } catch (e) {
      console.warn("/api/liff/address/me error:", e);
      setStatus(
        "お届け先を入力して「住所を保存して確認画面へ」を押してください。",
        ""
      );
    }
  } catch (e) {
    console.error("LIFF init error:", e);
    setStatus("初期化中にエラーが発生しました。時間をおいて再度お試しください。", "err");
  }
}

// 入力内容をまとめてチェック
function buildAddressFromForm() {
  const postal   = getVal("postal");
  const pref     = getVal("prefecture");
  const city     = getVal("city");
  const address1 = getVal("address1");
  const address2 = getVal("address2");
  const name     = getVal("name");
  const phone    = getVal("phone");

  if (!postal || !pref || !city || !address1 || !name || !phone) {
    setStatus(
      "郵便番号・都道府県・市区町村・番地/建物・お名前・電話番号は必須です。",
      "err"
    );
    return null;
  }

  return {
    postal,
    prefecture: pref,
    city,
    address1,
    address2,
    name,
    phone,
  };
}

// 住所保存後に戻る先URL（クエリを引き継ぐ）
function buildConfirmUrl() {
  const search = window.location.search || ""; // 例）?from=miniapp&xxx=yyy
  return "./confirm.html" + search;
}

// ✅ カート情報を取得（products.js 側で保存しておく前提）
function loadCartItems() {
  try {
    const raw = sessionStorage.getItem("cartItems");
    if (!raw) return [];
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    return items;
  } catch (e) {
    console.warn("cartItems parse error:", e);
    return [];
  }
}

// 「住所を保存して確認画面へ」ボタン
async function handleSaveAndGoConfirm() {
  if (!currentUserId) {
    setStatus("LINEユーザー情報が取得できていません。画面を閉じてもう一度お試しください。", "err");
    return;
  }

  const addr = buildAddressFromForm();
  if (!addr) return; // バリデーションNG

  try {
    saveBtn.disabled = true;
    setStatus("住所を保存しています…", "");

    const res = await fetch("/api/liff/address", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: currentUserId,
        address: addr,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      console.error("/api/liff/address response:", data);
      setStatus("住所の保存に失敗しました。時間をおいてもう一度お試しください。", "err");
      saveBtn.disabled = false;
      return;
    }

    // ✅ ここで orderDraft を作成して sessionStorage に保存
    const items = loadCartItems(); // [{ id, name, price, qty }, ...] を想定

    const orderDraft = {
      items,
      address: addr,
      lineUserId: currentUserId,
      lineUserName: currentUserName,
    };

    try {
      sessionStorage.setItem("orderDraft", JSON.stringify(orderDraft));
      console.log("orderDraft saved:", orderDraft);
    } catch (e) {
      console.warn("orderDraft save error:", e);
    }

    // ✅ 住所保存後、元と同じクエリ付きで confirm.html に戻る
    setStatus("住所を保存しました。確認画面に移動します…", "ok");
    window.location.href = buildConfirmUrl();
  } catch (e) {
    console.error("/api/liff/address error:", e);
    setStatus("通信エラーで住所を保存できませんでした。電波状況をご確認ください。", "err");
    saveBtn.disabled = false;
  }
}

// 「確認画面に戻る」ボタン
function handleBackToConfirm() {
  // クエリ付きでそのまま戻る
  window.location.href = buildConfirmUrl();
}

// イベント登録
document.addEventListener("DOMContentLoaded", () => {
  initLiffAddress();
  if (saveBtn) saveBtn.addEventListener("click", handleSaveAndGoConfirm);
  if (backBtn) backBtn.addEventListener("click", handleBackToConfirm);
});
