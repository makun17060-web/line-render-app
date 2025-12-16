// lib/shipping.js
// 送料ロジックの正本（ここだけ直せば全画面に反映）

const COD_FEE_YEN = 330;

// 地域別（例：ヤマト参考） 60/80サイズ
const SHIPPING_60 = {
  "北海道":1200,"東北":900,"関東":800,"信越":800,"北陸":800,"中部":800,
  "関西":850,"中国":950,"四国":950,"九州":1100,"沖縄":1400
};

const SHIPPING_80 = {
  "北海道":1400,"東北":1100,"関東":1000,"信越":1000,"北陸":1000,"中部":1000,
  "関西":1050,"中国":1150,"四国":1150,"九州":1300,"沖縄":1800
};

// 常に80サイズの商品（例：セット）
const ALWAYS_80_PRODUCT_IDS = new Set(["original-set-2000"]);

// ★個数でサイズ切替ルール（ここが正本）
function detectSizeForItem({ productId, qty }) {
  if (ALWAYS_80_PRODUCT_IDS.has(productId)) return 80;
  return qty >= 5 ? 80 : 60;
}

// カート全体でサイズを決める（最大サイズを採用）
function detectSizeForCart(items) {
  let size = 60;
  for (const it of items || []) {
    const q = Math.max(1, Number(it.qty || 1));
    const s = detectSizeForItem({ productId: it.productId, qty: q });
    if (s > size) size = s;
  }
  return size;
}

function quoteShipping({ region, items }) {
  const size = detectSizeForCart(items);
  const table = size === 80 ? SHIPPING_80 : SHIPPING_60;
  const shippingFee = table[region];

  if (shippingFee == null) {
    return { ok: false, error: "INVALID_REGION", region, size };
  }

  return {
    ok: true,
    region,
    size,
    shippingFee,
    codFee: COD_FEE_YEN,
  };
}

module.exports = {
  COD_FEE_YEN,
  SHIPPING_60,
  SHIPPING_80,
  ALWAYS_80_PRODUCT_IDS,
  detectSizeForItem,
  detectSizeForCart,
  quoteShipping,
};
