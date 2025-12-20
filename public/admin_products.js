// admin_products.js（修正版・丸ごと）
// 目的：404の原因だった /api/admin/products/update を使わず、
//      サーバーに存在する API に合わせて動作させる。
// 対応API（server-line.js に存在）:
//  - GET    /api/admin/products
//  - POST   /api/admin/upload-image   (multipart: image)
//  - GET    /api/admin/images
//  - DELETE /api/admin/images/:name
//  - POST   /api/admin/products/set-image  (JSON: { productId, imageUrl })

document.addEventListener("DOMContentLoaded", () => {
  const tokenInput   = document.getElementById("tokenInput");
  const saveTokenBtn = document.getElementById("saveTokenBtn");
  const authStatus   = document.getElementById("authStatus");

  const statusEl     = document.getElementById("status");
  const reloadBtn    = document.getElementById("reloadBtn");
  const listArea     = document.getElementById("listArea");

  const uploadInput  = document.getElementById("uploadInput");
  const uploadBtn    = document.getElementById("uploadBtn");
  const uploadStatus = document.getElementById("uploadStatus");

  const reloadImagesBtn = document.getElementById("reloadImagesBtn");
  const imagesList      = document.getElementById("imagesList");

  const STORAGE_KEY = "iso_admin_token";

  let currentProducts = [];
  let cachedImages = [];

  // =========================
  // Token
  // =========================
  function loadToken() {
    const t = localStorage.getItem(STORAGE_KEY) || "";
    if (tokenInput && !tokenInput.value) tokenInput.value = t;
    return t;
  }

  function getToken() {
    return (tokenInput.value || "").trim() || (localStorage.getItem(STORAGE_KEY) || "").trim();
  }

  function setAuth(ok, msg) {
    authStatus.textContent = msg;
    authStatus.style.color = ok ? "green" : "red";
  }

  function saveToken() {
    const t = (tokenInput.value || "").trim();
    if (!t) {
      setAuth(false, "トークンを入力してください。");
      return;
    }
    localStorage.setItem(STORAGE_KEY, t);
    setAuth(true, "保存しました。");
  }

  saveTokenBtn?.addEventListener("click", saveToken);
  tokenInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveToken();
    }
  });

  // =========================
  // API helpers
  // =========================
  function withToken(path) {
    const token = getToken();
    if (!token) {
      setAuth(false, "管理用トークンを入力して保存してください。");
      throw new Error("no_token");
    }
    const url = `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    return { url, token };
  }

  async function apiGet(path) {
    const { url, token } = withToken(path);
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    if (!data || data.ok !== true) throw new Error(`API error: ${(data && data.error) || "unknown"}`);
    return data;
  }

  async function apiPostJson(path, bodyObj) {
    const { url, token } = withToken(path);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(bodyObj || {}),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    if (!data || data.ok !== true) throw new Error(`API error: ${(data && data.error) || "unknown"}`);
    return data;
  }

  // =========================
  // Products
  // =========================
  async function fetchProducts() {
    statusEl.textContent = "商品一覧取得中...";
    listArea.textContent = "読み込み中...";
    try {
      const data = await apiGet("/api/admin/products");
      currentProducts = data.items || [];
      renderProducts(currentProducts);
      statusEl.textContent = `OK: 商品数 ${currentProducts.length} 件`;
    } catch (e) {
      console.error("fetchProducts error:", e);
      statusEl.textContent = "商品一覧の取得に失敗しました。";
      listArea.innerHTML = "";
      const pre = document.createElement("pre");
      pre.textContent = String(e.message || e);
      listArea.appendChild(pre);
    }
  }

  // ★重要：このサーバーには「name/price/stock/desc/image をまとめて更新する update API」が無い
  // なので「保存」ボタンは、確実に存在する /api/admin/products/set-image で画像だけ保存する。
  function renderProducts(items) {
    if (!items || items.length === 0) {
      listArea.textContent = "商品がありません。";
      return;
    }

    const table = document.createElement("table");
    table.style.borderCollapse = "collapse";
    table.style.width = "100%";

    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    ["ID", "商品名", "価格", "在庫", "説明", "画像URL", "プレビュー", "操作"].forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h;
      th.style.borderBottom = "1px solid #ddd";
      th.style.textAlign = "left";
      th.style.padding = "6px";
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    items.forEach((p) => {
      const tr = document.createElement("tr");

      // ID
      const tdId = document.createElement("td");
      tdId.textContent = p.id;
      tdId.style.padding = "6px";
      tr.appendChild(tdId);

      // 名称（表示のみ：編集しても保存されない）
      const tdName = document.createElement("td");
      const inputName = document.createElement("input");
      inputName.type = "text";
      inputName.value = p.name || "";
      inputName.style.width = "140px";
      inputName.disabled = true;
      inputName.title = "※このサーバーには商品情報更新APIがないため、名称はここから更新できません";
      tdName.appendChild(inputName);
      tdName.style.padding = "6px";
      tr.appendChild(tdName);

      // 価格（表示のみ）
      const tdPrice = document.createElement("td");
      const inputPrice = document.createElement("input");
      inputPrice.type = "number";
      inputPrice.value = p.price != null ? String(p.price) : "";
      inputPrice.style.width = "80px";
      inputPrice.disabled = true;
      inputPrice.title = "※このサーバーには商品情報更新APIがないため、価格はここから更新できません";
      tdPrice.appendChild(inputPrice);
      tdPrice.style.padding = "6px";
      tr.appendChild(tdPrice);

      // 在庫（表示のみ）
      const tdStock = document.createElement("td");
      const inputStock = document.createElement("input");
      inputStock.type = "number";
      inputStock.value = p.stock != null ? String(p.stock) : "0";
      inputStock.style.width = "60px";
      inputStock.disabled = true;
      inputStock.title = "※このサーバーには商品情報更新APIがないため、在庫はここから更新できません（在庫は別APIで操作）";
      tdStock.appendChild(inputStock);
      tdStock.style.padding = "6px";
      tr.appendChild(tdStock);

      // 説明（表示のみ）
      const tdDesc = document.createElement("td");
      const inputDesc = document.createElement("input");
      inputDesc.type = "text";
      inputDesc.value = p.desc || "";
      inputDesc.style.width = "200px";
      inputDesc.disabled = true;
      inputDesc.title = "※このサーバーには商品情報更新APIがないため、説明はここから更新できません";
      tdDesc.appendChild(inputDesc);
      tdDesc.style.padding = "6px";
      tr.appendChild(tdDesc);

      // 画像URL（これは保存できる）
      const tdImage = document.createElement("td");
      tdImage.style.padding = "6px";
      const inputImage = document.createElement("input");
      inputImage.type = "text";
      inputImage.value = p.image || "";
      inputImage.style.width = "240px";
      tdImage.appendChild(inputImage);

      const btnFromList = document.createElement("button");
      btnFromList.textContent = "一覧から選ぶ";
      btnFromList.style.marginLeft = "6px";
      btnFromList.addEventListener("click", async () => {
        try {
          if (!cachedImages.length) await fetchImages(true);
          if (!cachedImages.length) {
            alert("画像がまだありません。先にアップロードしてください。");
            return;
          }
          const options = cachedImages
            .map((img, i) => `${i + 1}: ${img.name} (${img.url})`)
            .join("\n");
          const input = window.prompt("使用する画像の番号を入力してください:\n" + options, "1");
          if (!input) return;
          const index = Number(input) - 1;
          if (index < 0 || index >= cachedImages.length) {
            alert("番号が不正です。");
            return;
          }
          const chosen = cachedImages[index];
          inputImage.value = chosen.url; // /public/uploads/xxx
          // プレビューも更新
          updatePreview(previewImg, inputImage.value);
        } catch (e) {
          console.error("select image error:", e);
          alert("画像一覧の取得に失敗しました。\n" + String(e.message || e));
        }
      });
      tdImage.appendChild(btnFromList);
      tr.appendChild(tdImage);

      // プレビュー
      const tdPrev = document.createElement("td");
      tdPrev.style.padding = "6px";
      const previewImg = document.createElement("img");
      previewImg.style.width = "56px";
      previewImg.style.height = "56px";
      previewImg.style.objectFit = "cover";
      previewImg.style.borderRadius = "6px";
      previewImg.style.border = "1px solid #ddd";
      updatePreview(previewImg, p.image || "");
      tdPrev.appendChild(previewImg);
      tr.appendChild(tdPrev);

      // 操作（画像だけ保存）
      const tdOps = document.createElement("td");
      tdOps.style.padding = "6px";

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "画像URLを保存";
      saveBtn.addEventListener("click", async () => {
        try {
          saveBtn.disabled = true;
          saveBtn.textContent = "保存中...";

          const imageUrl = (inputImage.value || "").trim();

          // ✅ サーバーに存在するAPIへ
          // body: { productId, imageUrl }
          await apiPostJson("/api/admin/products/set-image", {
            productId: p.id,
            imageUrl,
          });

          statusEl.textContent = `画像を保存しました：${p.id}`;
          updatePreview(previewImg, imageUrl);

          // 商品一覧を再取得して整合（任意）
          await fetchProducts();
        } catch (e) {
          console.error("save image error:", e);
          alert("保存に失敗しました。\n" + String(e.message || e));
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = "画像URLを保存";
        }
      });
      tdOps.appendChild(saveBtn);

      // 参考：在庫操作（既存APIあり）
      const stockBtn = document.createElement("button");
      stockBtn.textContent = "在庫を変更";
      stockBtn.style.marginLeft = "6px";
      stockBtn.title = "在庫は /api/admin/stock/set または /api/admin/stock/add で変更します";
      stockBtn.addEventListener("click", async () => {
        try {
          const input = prompt("在庫を何個にしますか？（半角数字）", String(p.stock ?? 0));
          if (input == null) return;
          const qty = Number(input);
          if (!Number.isFinite(qty) || qty < 0) {
            alert("数値が不正です");
            return;
          }
          await apiPostJson("/api/admin/stock/set", { productId: p.id, qty });
          statusEl.textContent = `在庫を更新しました：${p.id}`;
          await fetchProducts();
        } catch (e) {
          alert("在庫更新に失敗しました。\n" + String(e.message || e));
        }
      });
      tdOps.appendChild(stockBtn);

      tr.appendChild(tdOps);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    listArea.innerHTML = "";
    listArea.appendChild(table);

    const note = document.createElement("div");
    note.style.marginTop = "8px";
    note.style.fontSize = "12px";
    note.style.color = "#555";
    note.innerHTML =
      "※ このサーバーには <b>商品情報（名称/価格/説明）を更新するAPI</b> が無いので、ここでは編集できません。<br>" +
      "※ 画像は <code>/api/admin/products/set-image</code> で保存されます。";
    listArea.appendChild(note);
  }

  function updatePreview(imgEl, url) {
    const u = (url || "").trim();
    if (!u) {
      imgEl.src = "";
      imgEl.alt = "no image";
      imgEl.style.opacity = "0.3";
      imgEl.style.background = "#f5f5f5";
      return;
    }
    imgEl.style.opacity = "1";
    imgEl.style.background = "transparent";
    imgEl.src = u;
  }

  // =========================
  // Upload image
  // =========================
  async function uploadImage() {
    const token = getToken();
    if (!token) {
      setAuth(false, "管理用トークンを入力して保存してください。");
      return;
    }
    if (!uploadInput.files || !uploadInput.files[0]) {
      uploadStatus.textContent = "ファイルを選択してください。";
      uploadStatus.style.color = "red";
      return;
    }

    const file = uploadInput.files[0];
    uploadStatus.textContent = "アップロード中...";
    uploadStatus.style.color = "#666";

    try {
      const { url } = withToken("/api/admin/upload");
      const fd = new FormData();
      fd.append("image", file); // multer.single("image")

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
        },
        body: fd,
      });

      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}

      if (!res.ok || !data || data.ok !== true) {
        throw new Error(`upload failed: ${text}`);
      }

      uploadStatus.textContent = "アップロード成功：" + (data.path || data.url || data.file);
      uploadStatus.style.color = "green";
      uploadInput.value = "";

      // 画像一覧更新
      await fetchImages(true);

      // 便利：アップロード直後にURLをクリップボードへ
      const copyText = data.path || data.url || "";
      if (copyText && navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(copyText); } catch {}
      }
    } catch (e) {
      console.error("uploadImage error:", e);
      uploadStatus.textContent = "アップロード失敗：" + String(e.message || e);
      uploadStatus.style.color = "red";
    }
  }

  // =========================
  // Images list
  // =========================
  async function fetchImages(force) {
    if (!force && cachedImages.length) return cachedImages;

    imagesList.textContent = "画像一覧取得中...";
    imagesList.style.color = "#666";

    try {
      const data = await apiGet("/api/admin/images");
      const items = data.items || [];
      cachedImages = items;

      if (!items.length) {
        imagesList.textContent = "画像がありません。";
        return items;
      }

      const container = document.createElement("div");
      container.style.display = "flex";
      container.style.flexWrap = "wrap";
      container.style.gap = "8px";

      items.forEach((img) => {
        const card = document.createElement("div");
        card.style.border = "1px solid #ccc";
        card.style.borderRadius = "6px";
        card.style.padding = "6px";
        card.style.width = "220px";
        card.style.fontSize = "11px";
        card.style.background = "#fff";

        const thumb = document.createElement("img");
        thumb.src = img.url;
        thumb.style.width = "100%";
        thumb.style.height = "auto";
        thumb.style.maxHeight = "140px";
        thumb.style.objectFit = "contain";
        thumb.style.backgroundColor = "#f5f5f5";
        thumb.style.borderRadius = "6px";
        thumb.style.border = "1px solid #eee";
        card.appendChild(thumb);

        const nameDiv = document.createElement("div");
        nameDiv.textContent = img.name;
        nameDiv.style.marginTop = "6px";
        nameDiv.style.wordBreak = "break-all";
        card.appendChild(nameDiv);

        const urlDiv = document.createElement("div");
        urlDiv.textContent = img.url;
        urlDiv.style.wordBreak = "break-all";
        urlDiv.style.color = "#666";
        card.appendChild(urlDiv);

        const row = document.createElement("div");
        row.style.marginTop = "6px";
        row.style.display = "flex";
        row.style.gap = "6px";

        const copyBtn = document.createElement("button");
        copyBtn.textContent = "URLコピー";
        copyBtn.addEventListener("click", async () => {
          const u = img.url || "";
          if (!u) return;
          if (navigator.clipboard?.writeText) {
            try {
              await navigator.clipboard.writeText(u);
              alert("コピーしました:\n" + u);
            } catch {
              window.prompt("このURLをコピーしてください：", u);
            }
          } else {
            window.prompt("このURLをコピーしてください：", u);
          }
        });
        row.appendChild(copyBtn);

        const delBtn = document.createElement("button");
        delBtn.textContent = "削除";
        delBtn.addEventListener("click", async () => {
          if (!confirm(`削除しますか？\n${img.name}`)) return;
          try {
            const { url } = withToken(`/api/admin/images/${encodeURIComponent(img.name)}`);
            await fetch(url, {
              method: "DELETE",
              headers: { "Authorization": `Bearer ${getToken()}` },
            }).then(async (r) => {
              const t = await r.text();
              let j = null;
              try { j = JSON.parse(t); } catch {}
              if (!r.ok || !j || j.ok !== true) throw new Error(t);
            });
            await fetchImages(true);
          } catch (e) {
            alert("削除に失敗しました。\n" + String(e.message || e));
          }
        });
        row.appendChild(delBtn);

        card.appendChild(row);

        container.appendChild(card);
      });

      imagesList.innerHTML = "";
      imagesList.appendChild(container);
      return items;
    } catch (e) {
      console.error("fetchImages error:", e);
      imagesList.textContent = "画像一覧の取得に失敗しました。";
      imagesList.style.color = "red";
      return [];
    }
  }

  // =========================
  // Events
  // =========================
  reloadBtn?.addEventListener("click", fetchProducts);
  uploadBtn?.addEventListener("click", uploadImage);
  reloadImagesBtn?.addEventListener("click", () => fetchImages(true));

  // 初期
  loadToken();
  setAuth(false, "管理用トークンを入力して保存してください。");
  listArea.textContent = "「商品一覧を再読み込み」を押すと一覧が表示されます。";
});
