(async function () {
  const $ = (sel) => document.querySelector(sel);
  const show = (el, data) => {
    el.hidden = false;
    el.textContent =
      typeof data === "string" ? data : JSON.stringify(data, null, 2);
  };
  const auth = () => ({
    Authorization: "Bearer " + ($("#token").value || "").trim(),
    "Content-Type": "application/json",
  });

  // ====== 認証・状態 ======
  $("#btnPing").onclick = async () => {
    try {
      const r = await fetch("/api/admin/ping", { headers: auth() });
      const j = await r.json();
      alert(j.ok ? "OK" : "NG: " + (j.error || ""));
    } catch (e) {
      alert("ERR " + e);
    }
  };
  $("#btnHealth").onclick = async () => {
    try {
      const r = await fetch("/api/health");
      show($("#healthOut"), await r.json());
    } catch (e) {
      show($("#healthOut"), String(e));
    }
  };

  // ====== 商品データ取得 ======
  let allProducts = [];
  $("#btnLoadProducts").onclick = async () => {
    try {
      const r = await fetch("/api/admin/products", { headers: auth() });
      const j = await r.json();
      if (!j.ok) return alert("取得失敗");
      allProducts = j.items || [];
      $("#prodCount").textContent = `取得 ${allProducts.length} 件`;
      renderProductGrid(allProducts);
    } catch (e) {
      alert("ERR " + e);
    }
  };

  // ====== 商品画像のグリッド生成 ======
  function renderProductGrid(products) {
    const grid = $("#prodGrid");
    grid.innerHTML = "";
    products.forEach((p) => {
      const div = document.createElement("div");
      div.className = "pitem";
      div.innerHTML = `
        <div class="thumb" id="thumb-${p.id}">
          ${
            p.image
              ? `<img src="${p.image}" alt="${p.name}">`
              : "＋画像をドロップ"
          }
        </div>
        <h3>${p.name}</h3>
        <input type="file" id="file-${p.id}" accept="image/*" hidden>
        <button data-id="${p.id}" class="chooseBtn">画像を選ぶ</button>
      `;
      grid.appendChild(div);

      // ドラッグ＆ドロップ
      const thumb = $(`#thumb-${p.id}`);
      thumb.ondragover = (e) => e.preventDefault();
      thumb.ondrop = (e) => {
        e.preventDefault();
        if (!e.dataTransfer.files.length) return;
        uploadImage(p.id, e.dataTransfer.files[0]);
      };

      // ファイル選択
      div.querySelector(".chooseBtn").onclick = () => {
        $(`#file-${p.id}`).click();
      };
      $(`#file-${p.id}`).onchange = (ev) => {
        const f = ev.target.files[0];
        if (f) uploadImage(p.id, f);
      };
    });
  }

  // ====== アップロード処理 ======
  async function uploadImage(pid, file) {
    try {
      const form = new FormData();
      form.append("image", file);
      const up = await fetch("/api/upload-image", {
        method: "POST",
        body: form,
      });
      const j = await up.json();
      if (!j.ok) return alert("アップロード失敗");

      const url = j.url;
      const token = $("#token").value.trim();

      // products.json に保存
      const res = await fetch("/api/admin/products/set-image", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ productId: pid, imageUrl: url }),
      });
      const jr = await res.json();
      if (!jr.ok) return alert("保存失敗: " + (jr.error || ""));

      // 表示更新
      const thumb = $(`#thumb-${pid}`);
      thumb.innerHTML = `<img src="${url}" alt="product">`;
      alert("画像を更新しました ✅");
    } catch (e) {
      console.error("uploadImage error:", e);
      alert("ERR " + e);
    }
  }

  // ====== Flexメッセージ生成 ======
  function yen(n) {
    return Number(n || 0).toLocaleString("ja-JP") + "円";
  }

  function buildFlex() {
    const hideRaw = ($("#hideIds").value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const visible = allProducts.filter((p) => !hideRaw.includes(p.id));

    const bubbles = visible.map((p) => ({
      type: "bubble",
      ...(p.image
        ? {
            hero: {
              type: "image",
              url: p.image,
              size: "full",
              aspectMode: "cover",
              aspectRatio: "1:1",
            },
          }
        : {}),
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: p.name, weight: "bold", size: "md", wrap: true },
          {
            type: "text",
            text: `価格：${yen(p.price)}　在庫：${p.stock ?? 0}`,
            size: "sm",
            wrap: true,
          },
          p.desc
            ? { type: "text", text: p.desc, size: "sm", wrap: true }
            : { type: "box", layout: "vertical", contents: [] },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "postback",
              label: "数量を選ぶ",
              data: `order_qty?id=${encodeURIComponent(p.id)}&qty=1`,
            },
          },
        ],
      },
    }));

    // その他
    bubbles.push({
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: "その他（自由入力）", weight: "bold", size: "md" },
          {
            type: "text",
            text: "商品名と個数だけ入力します。価格入力は不要です。",
            size: "sm",
            wrap: true,
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            action: { type: "postback", label: "商品名を入力する", data: "other_start" },
          },
          {
            type: "button",
            style: "secondary",
            action: { type: "postback", label: "← 戻る", data: "order_back" },
          },
        ],
      },
    });

    return {
      type: "flex",
      altText: ($("#altText").value || "商品一覧").slice(0, 400),
      contents:
        bubbles.length === 1
          ? bubbles[0]
          : { type: "carousel", contents: bubbles },
    };
  }

  // ====== Flexプレビュー・配信 ======
  $("#btnBuildFlex").onclick = () => {
    if (!allProducts.length) return alert("商品を取得してください");
    show($("#flexPreview"), buildFlex());
  };

  $("#btnSendFlex").onclick = async () => {
    if (!allProducts.length) return alert("商品を取得してください");
    const payload = buildFlex();
    const ids = ($("#userIds").value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const url = ids.length
      ? "/api/admin/segment/send-flex"
      : "/api/admin/broadcast-flex";
    const body = ids.length
      ? { userIds: ids, altText: payload.altText, contents: payload.contents }
      : { altText: payload.altText, contents: payload.contents };
    const r = await fetch(url, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify(body),
    });
    const j = await r.json();
    $("#sendFlexRes").textContent = j.ok ? "OK" : "NG: " + (j.error || "");
  };

  // ====== テキスト配信 ======
  $("#btnSendText").onclick = async () => {
    const msg = ($("#textMessage").value || "").trim();
    if (!msg) return alert("本文が空です");
    const ids = ($("#textUserIds").value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const url = ids.length
      ? "/api/admin/segment/send"
      : "/api/admin/broadcast-flex";
    const body = ids.length
      ? { userIds: ids, message: msg }
      : {
          altText: "テキスト",
          contents: {
            type: "bubble",
            body: { type: "box", layout: "vertical", contents: [{ type: "text", text: msg, wrap: true }] },
          },
        };
    const r = await fetch(url, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify(body),
    });
    const j = await r.json();
    $("#sendTextRes").textContent = j.ok ? "OK" : "NG: " + (j.error || "");
  };
})();
