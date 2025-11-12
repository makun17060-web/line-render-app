// ====== 画像アップロード / 画像管理 API（要トークン） ======

// 単一画像アップロード：multipart/form-data, field name: "file"
app.post("/api/admin/upload-image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  upload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ ok:false, error: String(err.message || err) });
    }
    if (!req.file) return res.status(400).json({ ok:false, error:"file_required" });
    const filename = req.file.filename;
    const url = `/uploads/${filename}`;
    res.json({ ok:true, filename, url, size: req.file.size, mime: req.file.mimetype });
  });
});

// 画像一覧（簡易）
app.get("/api/admin/images", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const files = fs.readdirSync(UPLOAD_DIR).filter(f => !f.startsWith("."));
    const items = files.map(f => ({ filename: f, url: `/uploads/${f}` }));
    res.json({ ok:true, items });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// 画像削除（物理ファイル削除）
app.delete("/api/admin/images/:filename", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const filename = (req.params.filename || "").replace(/[^\w.\-]/g, "");
    const p = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ ok:true, deleted: filename });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// 商品に画像URLをひも付け
app.post("/api/admin/products/:id/image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = resolveProductId((req.params.id || "").trim());
    const url = (req.body?.url || "").trim();
    if (!url) return res.status(400).json({ ok:false, error:"url_required" });
    const products = readProducts();
    const i = products.findIndex(p => p.id === pid);
    if (i < 0) return res.status(404).json({ ok:false, error:"product_not_found" });
    products[i].imageUrl = url;
    writeProducts(products);
    res.json({ ok:true, product: products[i] });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// 商品の画像ひも付け解除（imageUrl削除）
app.delete("/api/admin/products/:id/image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = resolveProductId((req.params.id || "").trim());
    const products = readProducts();
    const i = products.findIndex(p => p.id === pid);
    if (i < 0) return res.status(404).json({ ok:false, error:"product_not_found" });
    delete products[i].imageUrl;
    writeProducts(products);
    res.json({ ok:true, product: products[i] });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});
