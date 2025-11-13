// public/admin.js

(function () {
  const $ = (id) => document.getElementById(id);

  const tokenInput = $("tokenInput");
  const connectBtn = $("connectBtn");
  const statusDiv = $("status");

  const fileInput = $("fileInput");
  const uploadBtn = $("uploadBtn");

  const imageListDiv = $("imageList");

  const productSelect = $("productSelect");
  const productInfo = $("productInfo");
  const productPreviewImg = $("productPreviewImg");
  const applyImageBtn = $("applyImageBtn");

  let adminToken = "";
  let images = [];
  let products = [];
  let selectedImageUrl = ""; // 絶対URL（https://〜）

  function logStatus(msg) {
    const now = new Date().toLocaleString();
    statusDiv.textContent = `[${now}] ${msg}`;
    console.log("[admin]", msg);
  }

  function toAbsoluteUrl(pathOrUrl) {
    if (!pathOrUrl) return "";
    // すでに http / https ならそのまま
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    // それ以外（/public/〜）は origin を付ける
    return window.location.origin + pathOrUrl;
  }

  // URL パラメータから code/token を拾って初期値にする
  (function initFromQuery() {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code") || params.get("token");
      if (code) {
        tokenInput.value = code;
      }
    } catch (e) {
      console.warn("query parse error", e);
    }
  })();

  async function connectionTest() {
    const t = (tokenInput.value || "").trim();
    if (!t) {
      alert("管理トークン（?code= または ADMIN_API_TOKEN）を入力してください。");
      return;
    }
    adminToken = t;
    logStatus("接続テスト中…");

    try {
      const res = await fetch(`/api/admin/connection-test?code=${encodeURIComponent(adminToken)}`, {
        method: "GET",
        credentials: "same-origin",
      });
      const json = await res.json();
      if (!json.ok) {
        logStatus("接続テスト失敗: " + JSON.stringify(json));
        alert("接続テストに失敗しました。\nトークン（code）が正しいか確認してください。");
        return;
      }
      logStatus("接続テスト成功: " + JSON.stringify(json));
      alert("接続テスト成功しました。画像一覧と商品一覧を読み込みます。");

      // 成功したら一覧をロード
      await Promise.all([loadImages(), loadProducts()]);
    } catch (e) {
      console.error(e);
      logStatus("接続テスト中にエラー: " + e.message);
      alert("接続テスト中にエラーが発生しました。コンソールを確認してください。");
    }
  }

  async function loadImages() {
    if (!adminToken) return;
    logStatus("画像一覧を取得中…");
    imageListDiv.innerHTML = "読み込み中…";

    try {
      const res = await fetch(`/api/admin/images?code=${encodeURIComponent(adminToken)}`, {
        method: "GET",
        credentials: "same-origin",
      });
      const json = await res.json();
      if (!json.ok) {
        imageListDiv.textContent = "取得エラー: " + (json.error || "");
        logStatus("画像一覧取得失敗: " + JSON.stringify(json));
        return;
      }
      images = json.items || [];
      renderImageList();
      logStatus(`画像一覧取得 OK (${images.length}件)`);
    } catch (e) {
      console.error(e);
      imageListDiv.textContent = "取得エラー";
      logStatus("画像一覧取得エラー: " + e.message);
    }
  }

  function renderImageList() {
    imageListDiv.innerHTML = "";
    if (!images.length) {
      imageListDiv.textContent = "まだ画像がありません。アップロードしてください。";
      return;
    }

    images.forEach((item, idx) => {
      const absUrl = toAbsoluteUrl(item.url);

      const div = document.createElement("div");
      div.className = "thumb";
      div.dataset.url = absUrl;

      const img = document.createElement("img");
      img.src = absUrl;
      img.alt = item.name || `image-${idx}`;

      const nameSpan = document.createElement("span");
      nameSpan.textContent = item.name || `画像${idx + 1}`;

      div.appendChild(img);
      div.appendChild(nameSpan);

      div.addEventListener("click", () => {
        document.querySelectorAll(".thumb.selected").forEach(el => el.classList.remove("selected"));
        div.classList.add("selected");
        selectedImageUrl = absUrl;
        logStatus("選択中の画像: " + selectedImageUrl);
      });

      imageListDiv.appendChild(div);
    });
  }

  async function uploadImage() {
    if (!adminToken) {
      alert("先に接続テストを行ってください。");
      return;
    }
    const file = fileInput.files[0];
    if (!file) {
      alert("アップロードする画像ファイルを選択してください。");
      return;
    }

    const form = new FormData();
    form.append("image", file);

    uploadBtn.disabled = true;
    logStatus("画像アップロード中…");

    try {
      const res = await fetch(`/api/admin/upload-image?code=${encodeURIComponent(adminToken)}`, {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (!json.ok) {
        logStatus("アップロード失敗: " + JSON.stringify(json));
        alert("アップロードに失敗しました: " + (json.error || ""));
        return;
      }
      logStatus("アップロード成功: " + json.url);
      // すぐ一覧更新
      await loadImages();
    } catch (e) {
      console.error(e);
      logStatus("アップロードエラー: " + e.message);
      alert("アップロード中にエラーが発生しました。");
    } finally {
      uploadBtn.disabled = false;
      fileInput.value = "";
    }
  }

  async function loadProducts() {
    if (!adminToken) return;
    logStatus("商品一覧を取得中…");
    productSelect.innerHTML = `<option value="">読み込み中…</option>`;

    try {
      const res = await fetch(`/api/admin/products?code=${encodeURIComponent(adminToken)}`, {
        method: "GET",
        credentials: "same-origin",
      });
      const json = await res.json();
      if (!json.ok) {
        logStatus("商品一覧取得失敗: " + JSON.stringify(json));
        productSelect.innerHTML = `<option value="">取得エラー</option>`;
        return;
      }
      products = json.items || [];
      renderProductSelect();
      logStatus(`商品一覧取得 OK (${products.length}件)`);
    } catch (e) {
      console.error(e);
      logStatus("商品一覧取得エラー: " + e.message);
      productSelect.innerHTML = `<option value="">取得エラー</option>`;
    }
  }

  function renderProductSelect() {
    productSelect.innerHTML = "";
    if (!products.length) {
      productSelect.innerHTML = `<option value="">商品がありません</option>`;
      return;
    }
    productSelect.appendChild(new Option("商品を選択してください", ""));
    products.forEach(p => {
      const label = `${p.name}（${p.id} / ${p.price}円 / 在庫${p.stock}）`;
      productSelect.appendChild(new Option(label, p.id));
    });
  }

  function updateProductPreview() {
    const pid = productSelect.value;
    const product = products.find(p => p.id === pid);
    if (!product) {
      productInfo.textContent = "";
      productPreviewImg.src = "";
      productPreviewImg.style.visibility = "hidden";
      return;
    }
    productPreviewImg.style.visibility = "visible";
    const abs = toAbsoluteUrl(product.image || "");
    if (abs) {
      productPreviewImg.src = abs;
    } else {
      productPreviewImg.src = "";
    }
    productInfo.textContent = `現在の画像URL: ${product.image || "(未設定)"}`;
  }

  async function applyImageToProduct() {
    const pid = productSelect.value;
    if (!pid) {
      alert("商品を選択してください。");
      return;
    }
    if (!selectedImageUrl) {
      alert("左側の画像一覧から、商品に設定したい画像をクリックして選択してください。");
      return;
    }
    if (!adminToken) {
      alert("先に接続テストを行ってください。");
      return;
    }

    const absUrl = toAbsoluteUrl(selectedImageUrl); // 念のため

    logStatus(`商品 ${pid} に画像を設定中…`);
    applyImageBtn.disabled = true;

    try {
      const res = await fetch(`/api/admin/products/set-image?code=${encodeURIComponent(adminToken)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: pid, imageUrl: absUrl }),
      });
      const json = await res.json();
      if (!json.ok) {
        logStatus("設定失敗: " + JSON.stringify(json));
        alert("画像設定に失敗しました: " + (json.error || ""));
        return;
      }
      logStatus("設定成功: " + JSON.stringify(json.product));
      alert("商品に画像を設定しました。LINE での表示もこの画像になります。");

      // ローカルの products も更新してプレビュー反映
      const idx = products.findIndex(p => p.id === pid);
      if (idx >= 0) {
        products[idx].image = json.product.image;
      }
      updateProductPreview();
    } catch (e) {
      console.error(e);
      logStatus("設定エラー: " + e.message);
      alert("画像設定中にエラーが発生しました。");
    } finally {
      applyImageBtn.disabled = false;
    }
  }

  // ===== イベント紐付け =====
  connectBtn.addEventListener("click", connectionTest);
  uploadBtn.addEventListener("click", uploadImage);
  productSelect.addEventListener("change", updateProductPreview);

  // 初期表示ではプレビュー画像を隠しておく
  productPreviewImg.style.visibility = "hidden";
})();
