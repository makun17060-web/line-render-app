// admin_products.js
// 磯屋 商品管理：一覧表示 + name/price/stock/desc/image 更新 + 画像アップロード/一覧

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

  // ===== トークン管理 =====
  function loadToken() {
    const t = localStorage.getItem(STORAGE_KEY) || "";
    if (tokenInput && !tokenInput.value) {
      tokenInput.value = t;
    }
    return t;
  }

  function getToken() {
    return (tokenInput.value || "").trim() || loadToken();
  }

  function saveToken() {
    const t = (tokenInput.value || "").trim();
    if (!t) {
      authStatus.textContent = "トークンを入力してください。";
      authStatus.style.color = "red";
      return;
    }
    localStorage.setItem(STORAGE_KEY, t);
    authStatus.textContent = "保存しました。";
    authStatus.style.color = "green";
  }

  saveTokenBtn?.addEventListener("click", saveToken);
  tokenInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveToken();
    }
  });

  // ===== APIヘルパ =====
  async function apiGet(path) {
    const token = getToken();
    if (!token) {
      authStatus.textContent = "管理用トークンを入力して保存してください。";
      authStatus.style.color = "red";
      throw new Error("no_token");
    }
    const url = `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json"
      }
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* ignore */ }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    if (!data || data.ok !== true) {
      throw new Error(`API error: ${(data && data.error) || "unknown"}`);
    }
    return data;
  }

  async function apiPostJson(path, bodyObj) {
    const token = getToken();
    if (!token) {
      authStatus.textContent = "管理用トークンを入力して保存してください。";
      authStatus.style.color = "red";
      throw new Error("no_token");
    }
    const url = `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(bodyObj || {})
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* ignore */ }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    if (!data || data.ok !== true) {
      throw new Error(`API error: ${(data && data.error) || "unknown"}`);
    }
    return data;
  }

  // ===== 商品一覧取得 =====
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

  // ===== 商品一覧表示（編集UI付き） =====
  function renderProducts(items) {
    if (!items || items.length === 0) {
      listArea.textContent = "商品がありません。";
      return;
    }

    const table = document.createElement("table");

    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    ["ID", "商品名", "価格", "在庫", "説明", "画像URL", "操作"].forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    items.forEach((p) => {
      const tr = document.createElement("tr");

      // ID（編集不可）
      const tdId = document.createElement("td");
      tdId.textContent = p.id;
      tbody.appendChild(tr);
      tr.appendChild(tdId);

      // 名称
      const tdName = document.createElement("td");
      const inputName = document.createElement("input");
      inputName.type = "text";
      inputName.value = p.name || "";
      inputName.style.width = "140px";
      tdName.appendChild(inputName);
      tr.appendChild(tdName);

      // 価格
      const tdPrice = document.createElement("td");
      const inputPrice = document.createElement("input");
      inputPrice.type = "number";
      inputPrice.value = p.price != null ? String(p.price) : "";
      inputPrice.style.width = "80px";
      tdPrice.appendChild(inputPrice);
      tr.appendChild(tdPrice);

      // 在庫
      const tdStock = document.createElement("td");
      const inputStock = document.createElement("input");
      inputStock.type = "number";
      inputStock.value = p.stock != null ? String(p.stock) : "0";
      inputStock.style.width = "60px";
      tdStock.appendChild(inputStock);
      tr.appendChild(tdStock);

      // 説明
      const tdDesc = document.createElement("td");
      const inputDesc = document.createElement("input");
      inputDesc.type = "text";
      inputDesc.value = p.desc || "";
      inputDesc.style.width = "200px";
      tdDesc.appendChild(inputDesc);
      tr.appendChild(tdDesc);

      // 画像URL
      const tdImage = document.createElement("td");
      const inputImage = document.createElement("input");
      inputImage.type = "text";
      inputImage.value = p.image || "";
      inputImage.style.width = "220px";
      tdImage.appendChild(inputImage);

      const btnFromList = document.createElement("button");
      btnFromList.textContent = "一覧から選ぶ";
      btnFromList.style.marginLeft = "4px";
      btnFromList.addEventListener("click", async () => {
        try {
          if (!cachedImages.length) {
            await fetchImages(true);
          }
          if (!cachedImages.length) {
            alert("画像がまだありません。先にアップロードしてください。");
            return;
          }
          const options = cachedImages
            .map((img, i) => `${i + 1}: ${img.name} (${img.url})`)
            .join("\n");
          const input = window.prompt(
            "使用する画像の番号を入力してください:\n" + options,
            "1"
          );
          if (!input) return;
          const index = Number(input) - 1;
          if (index < 0 || index >= cachedImages.length) {
            alert("番号が不正です。");
            return;
          }
          const chosen = cachedImages[index];
          inputImage.value = chosen.url; // /public/uploads/xxx
        } catch (e) {
          console.error("select image error:", e);
          alert("画像一覧の取得に失敗しました。");
        }
      });
      tdImage.appendChild(btnFromList);

      tr.appendChild(tdImage);

      // 操作ボタン
      const tdOps = document.createElement("td");
      const saveBtn = document.createElement("button");
      saveBtn.textContent = "保存";
      saveBtn.addEventListener("click", async () => {
        try {
          saveBtn.disabled = true;
          saveBtn.textContent = "保存中...";

          const body = {
            productId: p.id,
            name: inputName.value,
            price: inputPrice.value,
            stock: inputStock.value,
            desc: inputDesc.value,
            image: inputImage.value
          };

          await apiPostJson("/api/admin/products/update", body);
          statusEl.textContent = `保存しました：${p.id}`;
          await fetchProducts(); // 再読み込みして画面に反映
        } catch (e) {
          console.error("save product error:", e);
          alert("保存に失敗しました。\n" + String(e.message || e));
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = "保存";
        }
      });
      tdOps.appendChild(saveBtn);

      tr.appendChild(tdOps);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    listArea.innerHTML = "";
    listArea.appendChild(table);
  }

  // ===== 画像アップロード =====
  async function uploadImage() {
    const token = getToken();
    if (!token) {
      authStatus.textContent = "管理用トークンを入力して保存してください。";
      authStatus.style.color = "red";
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
      const url = `/api/admin/upload-image?token=${encodeURIComponent(token)}`;
      const fd = new FormData();
      fd.append("image", file);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`
        },
        body: fd
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* ignore */ }

      if (!res.ok || !data || data.ok !== true) {
        throw new Error(`upload failed: ${text}`);
      }

      uploadStatus.textContent = "アップロード成功：" + (data.url || data.path || data.file);
      uploadStatus.style.color = "green";
      uploadInput.value = "";
      await fetchImages(true);
    } catch (e) {
      console.error("uploadImage error:", e);
      uploadStatus.textContent = "アップロード失敗：" + String(e.message || e);
      uploadStatus.style.color = "red";
    }
  }

  // ===== 画像一覧取得 =====
  async function fetchImages(force) {
    if (!force && cachedImages.length) return cachedImages;
    imagesList.textContent = "画像一覧取得中...";
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
        card.style.borderRadius = "4px";
        card.style.padding = "4px";
        card.style.width = "180px";
        card.style.fontSize = "11px";
        card.style.background = "#fff";

        const thumb = document.createElement("img");
        thumb.src = img.url;
        thumb.style.width = "100%";
        thumb.style.height = "100px";
        thumb.style.objectFit = "cover";
        card.appendChild(thumb);

        const nameDiv = document.createElement("div");
        nameDiv.textContent = img.name;
        nameDiv.style.marginTop = "4px";
        card.appendChild(nameDiv);

        const urlDiv = document.createElement("div");
        urlDiv.textContent = img.url;
        urlDiv.style.wordBreak = "break-all";
        card.appendChild(urlDiv);

        const copyBtn = document.createElement("button");
        copyBtn.textContent = "URLコピー";
        copyBtn.style.marginTop = "4px";
        copyBtn.addEventListener("click", () => {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(img.url).then(
              () => alert("コピーしました:\n" + img.url),
              () => alert("コピーに失敗しました。")
            );
          } else {
            window.prompt("このURLをコピーしてください：", img.url);
          }
        });
        card.appendChild(copyBtn);

        imagesList.appendChild(container);
        container.appendChild(card);
      });

      imagesList.innerHTML = "";
      imagesList.appendChild(container);

      return items;
    } catch (e) {
      console.error("fetchImages error:", e);
      imagesList.textContent = "画像一覧の取得に失敗しました。";
      return [];
    }
  }

  // ===== イベント設定 =====
  reloadBtn?.addEventListener("click", fetchProducts);
  uploadBtn?.addEventListener("click", uploadImage);
  reloadImagesBtn?.addEventListener("click", () => fetchImages(true));

  // 初期表示
  loadToken();
  authStatus.textContent = "管理用トークンを入力して保存してください。";
  listArea.textContent = "「商品一覧を再読み込み」を押すと一覧が表示されます。";
});
