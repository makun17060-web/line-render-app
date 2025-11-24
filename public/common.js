// public/common.js
const LIFF_ID = "2008406620-G5j1gjzM"; // あなたのLIFF ID

const SHIPPING_BY_REGION = {
  "北海道": 1100, "東北": 900, "関東": 800, "中部": 800,
  "近畿": 900, "中国": 1000, "四国": 1000, "九州": 1100, "沖縄": 1400
};

const PREF_TO_REGION = {
  "北海道":"北海道",
  "青森県":"東北","岩手県":"東北","宮城県":"東北","秋田県":"東北","山形県":"東北","福島県":"東北",
  "茨城県":"関東","栃木県":"関東","群馬県":"関東","埼玉県":"関東","千葉県":"関東","東京都":"関東","神奈川県":"関東",
  "新潟県":"中部","富山県":"中部","石川県":"中部","福井県":"中部","山梨県":"中部","長野県":"中部",
  "岐阜県":"中部","静岡県":"中部","愛知県":"中部","三重県":"中部",
  "滋賀県":"近畿","京都府":"近畿","大阪府":"近畿","兵庫県":"近畿","奈良県":"近畿","和歌山県":"近畿",
  "鳥取県":"中国","島根県":"中国","岡山県":"中国","広島県":"中国","山口県":"中国",
  "徳島県":"四国","香川県":"四国","愛媛県":"四国","高知県":"四国",
  "福岡県":"九州","佐賀県":"九州","長崎県":"九州","熊本県":"九州","大分県":"九州","宮崎県":"九州","鹿児島県":"九州",
  "沖縄県":"沖縄"
};

function yen(n){ return (Number(n)||0).toLocaleString("ja-JP")+"円"; }

function loadState(){
  return {
    lineUserId: sessionStorage.getItem("lineUserId") || "",
    lineUserName: sessionStorage.getItem("lineUserName") || "",
    cart: JSON.parse(sessionStorage.getItem("cart") || "{}"),
    address: JSON.parse(sessionStorage.getItem("address") || "null"),
    confirmed: sessionStorage.getItem("confirmed")==="1",
    shipRegion: sessionStorage.getItem("shipRegion") || "",
    shipFee: Number(sessionStorage.getItem("shipFee") || 0),
    itemsTotal: Number(sessionStorage.getItem("itemsTotal") || 0),
    grandTotal: Number(sessionStorage.getItem("grandTotal") || 0),
  };
}
function saveState(partial){
  const st = loadState();
  const next = { ...st, ...partial };
  sessionStorage.setItem("lineUserId", next.lineUserId || "");
  sessionStorage.setItem("lineUserName", next.lineUserName || "");
  sessionStorage.setItem("cart", JSON.stringify(next.cart||{}));
  sessionStorage.setItem("address", JSON.stringify(next.address||null));
  sessionStorage.setItem("confirmed", next.confirmed ? "1":"0");
  sessionStorage.setItem("shipRegion", next.shipRegion || "");
  sessionStorage.setItem("shipFee", String(next.shipFee||0));
  sessionStorage.setItem("itemsTotal", String(next.itemsTotal||0));
  sessionStorage.setItem("grandTotal", String(next.grandTotal||0));
}

function calcShipFeeFromPref(pref){
  const region = PREF_TO_REGION[pref] || "";
  const fee = region ? (SHIPPING_BY_REGION[region]||0) : 0;
  return { region, fee };
}

async function initLiffAndProfile(domNameId){
  try{
    await liff.init({ liffId: LIFF_ID });
    const profile = await liff.getProfile();
    saveState({ lineUserId: profile.userId, lineUserName: profile.displayName || "LINEユーザー" });
    if(domNameId) document.getElementById(domNameId).textContent = profile.displayName || "LINEユーザー";
  }catch(e){
    console.error("LIFF init error", e);
    if(domNameId) document.getElementById(domNameId).textContent = "取得失敗";
  }
}

async function fetchProducts(){
  const res = await fetch("/api/products");
  const json = await res.json();
  if(!json.ok) throw new Error(json.error||"server_error");
  return json.products || [];
}
