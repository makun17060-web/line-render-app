<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>えびせん管理画面（画像管理付き）</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
      padding: 16px;
      background: #f5f5f5;
    }
    h1 {
      margin-top: 0;
      font-size: 20px;
    }
    .card {
      background: #fff;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    label {
      display: block;
      font-size: 12px;
      margin-bottom: 4px;
    }
    input[type="text"] {
      width: 100%;
      max-width: 320px;
      padding: 6px 8px;
      font-size: 13px;
      box-sizing: border-box;
    }
    button {
      padding: 6px 12px;
      font-size: 13px;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      margin-right: 4px;
      margin-top: 4px;
    }
    button.primary { background: #1976d2; color:#fff; }
    button.danger  { background: #d32f2f; color:#fff; }

    #log {
      background: #111;
      color: #eee;
      font-family: monospace;
      font-size: 11px;
      padding: 8px;
      border-radius: 4px;
      max-height: 240px;
      overflow: auto;
      white-space: pre-wrap;
    }
    .log-ok { color: #8bc34a; }
    .log-err { color: #ff5252; }

    #imageList {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 8px;
    }
    .thumb-card {
      background:#fff;
      border-radius:8px;
      padding:6px;
      box-shadow:0 1px 2px rgba(0,0,0,0.1);
      display:flex;
      flex-direction:column;
      align-items:center;
      font-size:11px;
    }
    .thumb-card img {
      width: 120px;
      height: 120px;
      object-fit: cover;
      border-radius:4px;
      background:#eee;
    }
    .thumb-url {
      width:100%;
      font-size:10px;
      word-break: break-all;
      margin-top:4px;
    }
    .thumb-actions {
      margin-top:4px;
      display:flex;
      flex-wrap:wrap;
      gap:4px;
      justify-content:center;
    }
    select, .prod-input {
      font-size:11px;
      padding:4px;
      max-width:140px;
    }
  </style>
</head>
<body>
  <h1>えびせん管理画面（画像管理付き）</h1>

  <!-- 認証トークン -->
  <div class="card">
    <label>管理トークン（ADMIN_API_TOKEN または ADMIN_CODE）</label>
    <input type="text" id="token" placeholder="例: my-secret-token" />
    <div style="margin-top:4px;">
      <button class="primary" id="btnConn">接続テスト</button>
      <span id="connStatus" style="font-size:12px; margin-left:8px;"></span>
    </div>
  </div>

  <!-- 画像アップロード -->
  <div class="card">
    <h2 style="font-size:16px; margin:0 0 8px;">画像アップロード</h2>
    <input type="file" id="fileInput" accept="image/*" />
    <button id="btnUpload" class="primary">アップロード</button>
    <div id="uploadInfo" style="font-size:12px; margin-top:4px;"></div>
  </div>

  <!-- 画像一覧 & 商品に紐付け -->
  <div class="card">
    <h2 style="font-size:16px; margin:0 0 8px;">画像一覧 &gt; 商品に紐付け</h2>
    <div style="margin-bottom:4px;">
      <button id="btnReloadImages">画像一覧を読み込み</button>
      <button id="btnReloadProducts">商品一覧を読み込み</button>
    </div>
    <div id="imageList"></div>
  </div>

  <!-- ログ -->
  <div class="card">
    <h2 style="font-size:16px; margin:0 0 8px;">ログ</h2>
    <pre id="log"></pre>
  </div>

  <script src="admin.js" defer></script>
</body>
</html>
