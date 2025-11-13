以下の2ファイルを `public/` フォルダに配置してください。

---

# 1) public/admin.html

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>管理画面｜画像アップロード＆商品ひも付け</title>
  <style>
    :root { --bg:#0f1115; --card:#171b22; --text:#e8ecf1; --muted:#a9b4c0; --accent:#3b82f6; --danger:#ef4444; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Noto Sans JP, sans-serif; background:var(--bg); color:var(--text); }
    header { position: sticky; top:0; background:rgba(15,17,21,.8); backdrop-filter: blur(8px); border-bottom:1px solid #1f2430; padding:12px 16px; z-index: 10; }
    header .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    input, button, select { border-radius:10px; border:1px solid #242a36; background:#11141a; color:var(--text); padding:10px 12px; }
    button { cursor:pointer; }
    button.primary { background:var(--accent); border-color:transparent; color:#fff; }
    button.ghost { background:transparent; border-color:#2a3242; color:var(--muted); }
    button.danger { background:var(--danger); border-color:transparent; color:#fff; }
    main { display:grid; grid-template-columns: 360px 1fr; gap:16px; padding:16px; }
    @media (max-width: 1000px) { main { grid-template-columns: 1fr; } }

    .card { background:var(--card); border:1px solid #1f2430; border-radius:16px; overflow:hidden; }
    .card h2 { margin:0; font-size:16px; padding:12px 14px; border-bottom:1px solid #1f2430; color:#cbd5e1; }
    .card .body { padding:12px; }

    .uploader { border:2px dashed #2b3344; border-radius:14px; padding:16px; text-align:center; color:var(--muted); }
    .uploader.dragover { border-color:var(--accent); color:#fff; background:#0f1420; }
    .uploader input { display:none; }

    .images { display:grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap:10px; }
    .imgItem { border:1px solid #2a3242; border-radius:12px; overflow:hidden; background:#0e1218; }
    .imgItem img { width:100%; aspect-ratio:1/1; object-fit:cover; display:block; }
    .imgItem .row { display:flex; gap:6px; padding:8px; }

    .products { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:12px; }
    .prod { border:1px solid #2a3242; border-radius:14px; overflow:hidden; background:#0e1218; display:flex; flex-direction:column; }
    .prod .thumb { width:100%; aspect-ratio:20/13; background:#0b0e13; display:grid; place-items:center; color:#6b7280; }
    .prod .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
    .prod .info { padding:10px 12px; font-size:14px; display:grid; gap:6px; }
    .prod .actions { display:flex; gap:8px; padding:10px 12px; border-top:1px solid #1f2430; }
    .muted { color:var(--muted); font-size:12px; }
    .row { display:flex; gap:8px; align-items:center; }
    .sep { height:1px; background:#1f2430; margin:10px 0; }
    .pill { padding:2px 8px; border-radius:999px; background:#0e1525; border:1px solid #23304b; color:#9fb3c8; font-size:12px; }
    .hint { font-size:12px; color:#9fb3c8; }
  </style>
</head>
<body>
  <header>
    <div class="row">
      <strong>管理トークン</strong>
      <input id="tokenInput" type="password" placeholder="ADMIN_API_TOKEN または ADMIN_CODE" style="min-width:260px;"/>
      <button id="saveTokenBtn" class="primary">保存</button>
      <span id="pingStatus" class="pill">未接続</span>
      <span class="hint">RenderのURL例: https://xxxx.onrender.com</span>
    </div>
  </header>

  <main>
    <!-- 左カラム：画像管理 -->
    <section class="card">
      <h2>画像アップロード</h2>
      <div class="body">
        <div id="uploader" class="uploader">
          <p>ここにドラッグ＆ドロップ または <label for="fileInput" style="text-decoration:underline; cursor:pointer;">ファイルを選択</label></p>
          <input id="fileInput" type="file" accept="image/*" multiple />
          <p class="muted">対応: JPG/PNG/WEBP/GIF（最大5MB／枚）</p>
        </div>
        <div class="sep"></div>
        <div class="row" style="justify-content:space-between;">
          <h3 style="margin:0; font-size:14px; color:#cbd5e1;">アップロード済み</h3>
          <button id="refreshImagesBtn" class="ghost">再読み込み</button>
        </div>
        <div id="images" class="images" style="margin-top:8px;"></div>
      </div>
    </section>

    <!-- 右カラム：商品管理 -->
    <section class="card">
      <h2>商品に画像をひも付け</h2>
      <div class="body">
        <div class="row" style="justify-content:space-between;">
          <div class="hint">商品一覧は /api/admin/products から取得</div>
          <div class="row">
            <button id="refreshProductsBtn" class="ghost">商品を再取得</button>
          </div>
        </div>
        <div id="products" class="products" style="margin-top:8px;"></div>
      </div>
    </section>
  </main>

  <script src="/public/admin.js"></script>
</body>
</html>
```

---

# 2) public/admin.js

```js
(function(){
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const API = {
    ping: "/api/admin/ping",
    images: "/api/admin/images",
    upload: "/api/admin/upload-image",
    products: "/api/admin/products",
    setImage: (id) => `/api/admin/products/${encodeURIComponent(id)}/image`,
    delImage: (fname) => `/api/admin/images/${encodeURIComponent(fname)}`,
  };

  // ===== Token handling =====
  const tokenInput = $("#tokenInput");
  const saveTokenBtn = $("#saveTokenBtn");
  const pingStatus = $("#pingStatus");
  const headers = () => {
    const t = localStorage.getItem("admin_token") || "";
    const h = { "Content-Type": "application/json" };
    if (t) h["Authorization"] = `Bearer ${t}`;
    return h;
  };
  const setStatus = (text, color) => {
    pingStatus.textContent = text;
    pingStatus.style.background = color || "#0e1525";
    pingStatus.style.borderColor = "#23304b";
  };

  // ===== Ping =====
  async function ping(){
    try{
      const r = await fetch(API.ping, { headers: headers() });
      const j = await r.json();
      if (j && j.ok) setStatus("接続OK", "#15803d"); else setStatus("認証エラー", "#7f1d1d");
    }catch(e){ setStatus("未接続", "#7f1d1d"); }
  }

  // ===== Images =====
  const imagesWrap = $("#images");
  async function loadImages(){
    imagesWrap.innerHTML = "<div class='muted'>読み込み中...</div>";
    try{
      const r = await fetch(API.images, { headers: headers() });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error||"images_error");
      imagesWrap.innerHTML = "";
      for (const it of j.items){
        const card = document.createElement("div");
        card.className = "imgItem";
        card.innerHTML = `
          <img src="${it.url}" alt="${it.filename}" />
          <div class="row">
            <button class="primary" data-url="${it.url}">この画像を使う</button>
            <button class="danger" data-del="${it.filename}">削除</button>
          </div>
        `;
        imagesWrap.appendChild(card);
      }
    }catch(e){
      imagesWrap.innerHTML = `<div class='muted'>画像の取得に失敗しました: ${e.message||e}</div>`;
    }
  }

  imagesWrap.addEventListener("click", async (ev)=>{
    const useBtn = ev.target.closest("button.primary[data-url]");
    const delBtn = ev.target.closest("button.danger[data-del]");
    if (useBtn){
      const url = useBtn.getAttribute("data-url");
      // 右ペインの「選択中商品」に張り付けるイメージ: 各商品カードの「画像URL」欄に挿入
      const focused = $(".prod[data-focus='1']");
      if (!focused){ alert("先に右側の商品カードで『選択』してください。"); return; }
      const id = focused.getAttribute("data-id");
      await setProductImage(id, url);
      await loadProducts();
      // スクロールで同じ位置に戻す
      focused.scrollIntoView({ behavior:"smooth", block:"center" });
    }
    if (delBtn){
      const fname = delBtn.getAttribute("data-del");
      if (!confirm(`画像 ${fname} を削除しますか？`)) return;
      try{
        const r = await fetch(API.delImage(fname), { method:"DELETE", headers: headers() });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error||"delete_failed");
        await loadImages();
      }catch(e){ alert("削除に失敗: "+(e.message||e)); }
    }
  });

  // ===== Upload (DnD + input) =====
  const uploader = $("#uploader");
  const fileInput = $("#fileInput");
  const refreshImagesBtn = $("#refreshImagesBtn");

  function prevent(e){ e.preventDefault(); e.stopPropagation(); }
  ["dragenter","dragover","dragleave","drop"].forEach(ev=>uploader.addEventListener(ev, prevent));
  ["dragenter","dragover"].forEach(ev=>uploader.addEventListener(ev, ()=>uploader.classList.add("dragover")));
  ;["dragleave","drop"].forEach(ev=>uploader.addEventListener(ev, ()=>uploader.classList.remove("dragover")));

  uploader.addEventListener("drop", (e)=>{
    const files = e.dataTransfer.files;
    if (files && files.length) uploadFiles(files);
  });
  fileInput.addEventListener("change", ()=>{
    if (fileInput.files && fileInput.files.length) uploadFiles(fileInput.files);
  });
  refreshImagesBtn.addEventListener("click", loadImages);

  async function uploadFiles(fileList){
    for (const f of fileList){
      const fd = new FormData();
      fd.append("file", f);
      try{
        const r = await fetch(API.upload, { method:"POST", headers: { "Authorization": headers()["Authorization"] || "" }, body: fd });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error||"upload_failed");
      }catch(e){ alert(`アップロード失敗: ${f.name} → ${e.message||e}`); }
    }
    await loadImages();
  }

  // ===== Products =====
  const productsWrap = $("#products");
  const refreshProductsBtn = $("#refreshProductsBtn");

  async function loadProducts(){
    productsWrap.innerHTML = "<div class='muted'>読み込み中...</div>";
    try{
      const r = await fetch(API.products, { headers: headers() });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error||"products_error");
      const list = j.items || [];
      productsWrap.innerHTML = "";
      for (const p of list){
        const card = document.createElement("div");
        card.className = "prod";
        card.setAttribute("data-id", p.id);
        card.innerHTML = `
          <div class="thumb">${p.imageUrl ? `<img src="${p.imageUrl}" alt="${p.name}">` : "画像なし"}</div>
          <div class="info">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
              <div style="font-weight:700;">${p.name}</div>
              <span class="pill">${p.id}</span>
            </div>
            <div class="muted">価格：${Number(p.price).toLocaleString("ja-JP")}円　在庫：${Number(p.stock||0)}個</div>
            <div class="row">
              <input class="imgUrlInput" type="text" placeholder="/uploads/xxxx.webp または https://..." value="${p.imageUrl||""}" style="flex:1;" />
              <button class="primary attachBtn">反映</button>
            </div>
            <div class="row">
              <button class="ghost focusBtn">選択</button>
              ${p.imageUrl ? `<button class="danger removeBtn">画像解除</button>` : ""}
            </div>
          </div>
        `;
        productsWrap.appendChild(card);
      }
    }catch(e){
      productsWrap.innerHTML = `<div class='muted'>商品取得に失敗しました: ${e.message||e}</div>`;
    }
  }

  async function setProductImage(id, url){
    try{
      const body = JSON.stringify({ url });
      const r = await fetch(API.setImage(id), { method:"POST", headers: headers(), body });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error||"set_image_failed");
      return j.product;
    }catch(e){ alert("画像反映に失敗: "+(e.message||e)); throw e; }
  }

  productsWrap.addEventListener("click", async (ev)=>{
    const card = ev.target.closest(".prod");
    if (!card) return;
    const id = card.getAttribute("data-id");

    if (ev.target.matches(".attachBtn")){
      const url = card.querySelector(".imgUrlInput").value.trim();
      if (!url) { alert("画像URLを入力してください。"); return; }
      await setProductImage(id, url);
      await loadProducts();
      card.scrollIntoView({ behavior:"smooth", block:"center" });
    }

    if (ev.target.matches(".removeBtn")){
      if (!confirm("この商品の画像設定を解除しますか？")) return;
      try{
        const r = await fetch(API.setImage(id), { method:"DELETE", headers: headers() });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error||"remove_image_failed");
        await loadProducts();
        card.scrollIntoView({ behavior:"smooth", block:"center" });
      }catch(e){ alert("解除に失敗: "+(e.message||e)); }
    }

    if (ev.target.matches(".focusBtn")){
      $$(".prod").forEach(el=>el.removeAttribute("data-focus"));
      card.setAttribute("data-focus","1");
      card.style.outline = "2px solid #3b82f6";
      setTimeout(()=>{ card.style.outline = ""; }, 400);
    }
  });

  refreshProductsBtn.addEventListener("click", loadProducts);

  // ===== Bootstrap =====
  (function init(){
    const saved = localStorage.getItem("admin_token") || "";
    if (saved) tokenInput.value = saved;
    saveTokenBtn.addEventListener("click", ()=>{
      const t = tokenInput.value.trim();
      localStorage.setItem("admin_token", t);
      ping(); loadImages(); loadProducts();
    });
    // 初回ロード
    ping(); loadImages(); loadProducts();
  })();
})();
```
