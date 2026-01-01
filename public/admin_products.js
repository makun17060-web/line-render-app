/* admin_products.js - 商品管理（磯屋） */

"use strict";

const $ = (sel) => document.querySelector(sel);

const tokenInput = $("#tokenInput");
const saveTokenBtn = $("#saveTokenBtn");
const authStatus = $("#authStatus");

const reloadBtn = $("#reloadBtn");
const statusEl = $("#status");
const listArea = $("#listArea");

const uploadInput = $("#uploadInput");
const uploadBtn = $("#uploadBtn");
const uploadStatus = $("#uploadStatus");

const reloadImagesBtn = $("#reloadImagesBtn");
const imagesList = $("#imagesList");

// ===== 設定 =====
const LS_KEY = "ISOYA_ADMIN_TOKEN";

// ===== トークン =====
function getToken() {
  return (localStorage.getItem(LS_KEY) || "").trim();
}
function setToken(t) {
  localStorage.setItem(LS_KEY, (t || "").trim());
}
function authHeaders() {
  const t = getToken();
  return {
    "Content-Type": "application/json",
    "x-admin-token": t, // server側で揺れ吸収してるけど、これを正式採用
  };
}
function setStatus(msg = "", isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#b91c1c" : "#111827";
}
function setAuthStatus(msg = "", isError = false) {
  authStatus.textContent = msg;
  authStatus.style.color = isError ? "#b91c1c" : "#059669";
}

// ===== API =====
async function apiGet(path, admin = false) {
  const res = await fetch(path, {
    method: "GET",
    headers: admin ? authHeaders() : {},
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `HTTP_${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

async function apiPost(path, body, admin = false) {
  const res = await fetch(path, {
    method: "POST",
    headers: admin ? authHeaders() : { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `HTTP_${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

// ===== UI: 商品一覧 =====
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderProducts(products) {
  if (!Array.isArray(products) || products.length === 0) {
    listArea.innerHTML = `<div class="muted">商品がありません。</div>`;
    return;
  }

  const rows = products.map((p) => {
    const id = escapeHtml(p.id);
    const name = escapeHtml(p.name);
    const price = Number(p.price || 0);
    const stock = Number(p.stock || 0);
    const volume = escapeHtml(p.volume || "");
    const desc = escapeHtml(p.desc || "");
    const image = escapeHtml(p.image || "");

    return `
      <tr data-id="${id}">
        <td class="mono">${id}</td>
        <td><input class="inp name" value="${name}"></td>
        <td><input class="inp price" type="number" value="${price}"></td>
        <td><input class="inp stock" type="number" value="${stock}"></td>
        <td><input class="inp volume" value="${volume}"></td>
        <td><input class="inp image" value="${image}" placeholder="https://.../public/uploads/xxx.png"></td>
        <td><textarea class="ta desc" rows="2">${desc}</textarea></td>
        <td class="actions">
          <button class="btn save">保存</button>
          <button class="btn danger del">削除</button>
        </td>
      </tr>
    `;
  }).join("");

  listArea.innerHTML = `
    <table class="tbl">
      <thead>
        <tr>
          <th>ID</th>
          <th>商品名</th>
          <th>価格</th>
          <th>在庫</th>
          <th>内容量</th>
          <th>画像URL</th>
          <th>説明</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <div class="addBox">
      <h3>商品を追加</h3>
      <div class="grid">
        <label>ID <input id="add_id" class="inp" placeholder="new-product-001"></label>
        <label>商品名 <input id="add_name" class="inp" placeholder="新商品"></label>
        <label>価格 <input id="add_price" class="inp" type="number" value="0"></label>
        <label>在庫 <input id="add_stock" class="inp" type="number" value="0"></label>
        <label>内容量 <input id="add_volume" class="inp" placeholder="80g"></label>
        <label>画像URL <input id="add_image" class="inp" placeholder="https://.../public/uploads/..."></label>
      </div>
      <label>説明
        <textarea id="add_desc" class="ta" rows="2" placeholder="説明..."></textarea>
      </label>
      <button id="addBtn" class="btn">追加</button>
      <span id="addStatus" class="muted"></span>
    </div>
  `;

  // 行ボタン
  listArea.querySelectorAll("tr[data-id]").forEach((tr) => {
    const id = tr.getAttribute("data-id");

    tr.querySelector(".save").addEventListener("click", async () => {
      try {
        setStatus("保存中…");
        const body = {
          id,
          name: tr.querySelector(".name").value.trim(),
          price: Number(tr.querySelector(".price").value || 0),
          stock: Number(tr.querySelector(".stock").value || 0),
          volume: tr.querySelector(".volume").value.trim(),
          image: tr.querySelector(".image").value.trim(),
          desc: tr.querySelector(".desc").value.trim(),
        };
        await apiPost("/api/admin/products/update", body, true);
        setStatus(`保存しました：${id}`);
      } catch (e) {
        setStatus(`保存失敗：${id} / ${e.message}`, true);
      }
    });

    tr.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`削除しますか？\nID: ${id}`)) return;
      try {
        setStatus("削除中…");
        await apiPost("/api/admin/products/delete", { id }, true);
        setStatus(`削除しました：${id}`);
        await loadProductsAndRender();
      } catch (e) {
        setStatus(`削除失敗：${id} / ${e.message}`, true);
      }
    });
  });

  // 追加ボタン
  const addBtn = $("#addBtn");
  const addStatus = $("#addStatus");
  addBtn.addEventListener("click", async () => {
    try {
      addStatus.textContent = "追加中…";
      const body = {
        id: $("#add_id").value.trim(),
        name: $("#add_name").value.trim(),
        price: Number($("#add_price").value || 0),
        stock: Number($("#add_stock").value || 0),
        volume: $("#add_volume").value.trim(),
        image: $("#add_image").value.trim(),
        desc: $("#add_desc").value.trim(),
      };
      await apiPost("/api/admin/products/add", body, true);
      addStatus.textContent = "追加しました";
      await loadProductsAndRender();
    } catch (e) {
      addStatus.textContent = `追加失敗：${e.message}`;
    }
  });
}

async function loadProductsAndRender() {
  // 管理用に /api/admin/products を使う（トークン必須）
  const data = await apiGet("/api/admin/products", true);
  renderProducts(data.products || []);
}

// ===== UI: 画像アップロード =====
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

async function uploadImage() {
  const file = uploadInput.files && uploadInput.files[0];
  if (!file) {
    uploadStatus.textContent = "ファイルを選んでください";
    uploadStatus.style.color = "#b91c1c";
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    uploadStatus.textContent = "8MBを超えています";
    uploadStatus.style.color = "#b91c1c";
    return;
  }

  try {
    uploadStatus.textContent = "読み込み中…";
    uploadStatus.style.color = "#111827";

    const dataUrl = await readFileAsDataURL(file);
    const mime = (dataUrl.match(/^data:(.*?);base64,/) || [])[1] || file.type || "image/png";
    const contentBase64 = dataUrl; // server側で data:...;base64, を剥がしているのでOK

    uploadStatus.textContent = "アップロード中…";

    const r = await apiPost("/api/admin/upload-image", {
      filename: file.name,
      mime,
      contentBase64,
    }, true);

    uploadStatus.textContent = `アップロードOK：${r.url}`;
    uploadStatus.style.color = "#059669";

    // 画像一覧も更新
    await loadImagesAndRender();
  } catch (e) {
    uploadStatus.textContent = `失敗：${e.message}`;
    uploadStatus.style.color = "#b91c1c";
  }
}

// ===== UI: 画像一覧 =====
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function renderImages(images) {
  if (!Array.isArray(images) || images.length === 0) {
    imagesList.innerHTML = `<div class="muted">画像がありません。</div>`;
    return;
  }

  imagesList.innerHTML = `
    <div class="imgGrid">
      ${images.map(img => `
        <div class="imgCard">
          <div class="thumb">
            <img src="${img.url}" alt="${escapeHtml(img.name)}" loading="lazy">
          </div>
          <div class="imgMeta">
            <div class="mono small">${escapeHtml(img.name)}</div>
            <div class="url mono small">${escapeHtml(img.url)}</div>
            <button class="btn small copy" data-url="${escapeHtml(img.url)}">URLコピー</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;

  imagesList.querySelectorAll(".copy").forEach(btn => {
    btn.addEventListener("click", async () => {
      const url = btn.getAttribute("data-url") || "";
      const ok = await copyText(url);
      btn.textContent = ok ? "コピーしました" : "コピー失敗";
      setTimeout(() => (btn.textContent = "URLコピー"), 900);
    });
  });
}

async function loadImagesAndRender() {
  const data = await apiGet("/api/admin/images", true);
  renderImages(data.images || []);
}

// ===== 初期化 =====
function init() {
  tokenInput.value = getToken();

  saveTokenBtn.addEventListener("click", () => {
    const t = tokenInput.value.trim();
    if (!t) {
      setAuthStatus("トークンを入力してください", true);
      return;
    }
    setToken(t);
    setAuthStatus("保存しました");
  });

  reloadBtn.addEventListener("click", async () => {
    try {
      setStatus("読み込み中…");
      await loadProductsAndRender();
      setStatus("読み込み完了");
    } catch (e) {
      setStatus(`読み込み失敗：${e.message}`, true);
    }
  });

  uploadBtn.addEventListener("click", uploadImage);

  reloadImagesBtn.addEventListener("click", async () => {
    try {
      uploadStatus.textContent = "";
      await loadImagesAndRender();
    } catch (e) {
      imagesList.textContent = `失敗：${e.message}`;
    }
  });

  // 起動時：画像一覧だけは読み込みを試す（トークン入ってれば即表示）
  if (getToken()) {
    loadImagesAndRender().catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
