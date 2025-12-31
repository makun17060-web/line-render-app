"use strict";

const orderListEl = document.getElementById("orderList");
const sumItemsEl = document.getElementById("sumItems");
const sumShippingEl = document.getElementById("sumShipping");
const sumCodEl = document.getElementById("sumCod");
const sumTotalCodEl = document.getElementById("sumTotalCod");
const statusEl = document.getElementById("statusMsg");

const cardBtn = document.getElementById("cardBtn");
const codBtn = document.getElementById("codBtn");
const backBtn = document.getElementById("backBtn");

const COD_FEE = 330;

function setStatus(msg=""){ if(statusEl) statusEl.textContent = msg; }
function yen(n){ return (Number(n)||0).toLocaleString("ja-JP")+"円"; }
function safeJsonParse(s){ try{return JSON.parse(s);}catch{return null;} }

function readOrder() {
  const keys = ["orderDraft","currentOrder","order","confirm_normalized_order"];
  for (const k of keys) {
    const raw = sessionStorage.getItem(k) || localStorage.getItem(k);
    if (!raw) continue;
    const obj = safeJsonParse(raw);
    if (obj && typeof obj === "object") return obj;
  }
  return null;
}
function saveOrder(order) {
  sessionStorage.setItem("orderDraft", JSON.stringify(order));
  sessionStorage.setItem("order", JSON.stringify(order));
  sessionStorage.setItem("currentOrder", JSON.stringify(order));
  sessionStorage.setItem("confirm_normalized_order", JSON.stringify(order));
  localStorage.setItem("order", JSON.stringify(order));
}

async function calcShipping(items, prefecture) {
  const pref = String(prefecture||"").trim();
  if (!pref) return 0;
  const r = await fetch("/api/shipping", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ items, prefecture: pref })
  });
  const j = await r.json().catch(()=>({}));
  if (!r.ok || !j.ok) return 0;
  return Number(j.fee||0);
}

function renderItems(items) {
  orderListEl.innerHTML = "";
  items.forEach(it=>{
    const div = document.createElement("div");
    div.className = "order-row";
    div.textContent = `${it.name} ×${it.qty} = ${yen(it.price*it.qty)}`;
    orderListEl.appendChild(div);
  });
}

(async function main(){
  try {
    const order = readOrder();
    if (!order) {
      setStatus("注文情報が見つかりません。\n商品一覧からやり直してください。");
      cardBtn.disabled = true;
      codBtn.disabled = true;
      return;
    }

    const items = (order.items||[]).map(it=>({
      id: String(it.id||"").trim(),
      name: String(it.name||it.id||"商品"),
      price: Number(it.price||0),
      qty: Number(it.qty||0),
    })).filter(it=>it.id && it.qty>0);

    if (!items.length) {
      setStatus("カートが空です。");
      cardBtn.disabled = true;
      codBtn.disabled = true;
      return;
    }

    if (!order.address?.prefecture) {
      setStatus("住所が未入力です。住所入力へ戻って保存してください。");
      cardBtn.disabled = true;
      codBtn.disabled = true;
      return;
    }

    renderItems(items);

    const itemsTotal = items.reduce((s,it)=>s+it.price*it.qty,0);
    const shipping = await calcShipping(items, order.address.prefecture);

    order.itemsTotal = itemsTotal;
    order.shipping_fee = shipping;
    saveOrder(order);

    sumItemsEl.textContent = yen(itemsTotal);
    sumShippingEl.textContent = yen(shipping);
    sumCodEl.textContent = `${COD_FEE}円（代引きの場合のみ）`;
    sumTotalCodEl.textContent = yen(itemsTotal + shipping + COD_FEE);

    setStatus("支払方法を選んでください。");

    backBtn.addEventListener("click", ()=> location.href="./liff-address.html");

    // ★最重要：遷移前に必ず orderDraft を保存（confirm-codで null にならない）
    codBtn.addEventListener("click", ()=>{
      saveOrder(order);
      location.href = "./confirm-cod.html";
    });

    // カード側（あなたのstripe画面に合わせて変更OK）
    cardBtn.addEventListener("click", ()=>{
      saveOrder(order);
      location.href = "./card-detail.html"; // 必要ならあなたのファイル名へ
    });

  } catch(e){
    setStatus("エラー:\n"+(e?.message||String(e)));
    cardBtn.disabled = true;
    codBtn.disabled = true;
  }
})();
