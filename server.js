"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const app = express();

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const LIFF_ID = (process.env.LIFF_ID || "").trim();
const ADMIN_API_TOKEN = (process.env.ADMIN_API_TOKEN || "").trim();
const BANK_INFO = (process.env.BANK_INFO || "").trim();
const BANK_NOTE = (process.env.BANK_NOTE || "").trim();
const config = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret:      (process.env.LINE_CHANNEL_SECRET || "").trim(),
};

if (!config.channelAccessToken || !config.channelSecret || !LIFF_ID || !ADMIN_API_TOKEN) {
  console.error("ERROR: Missing required .env");
  process.exit(1);
}

// ====== Data paths (Persistent Disk) ======
const DATA_DIR         = "/data"; // <== Render Disk
const PRODUCTS_PATH    = path.join(DATA_DIR, "products.json");
const ORDERS_LOG       = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG = path.join(DATA_DIR, "reservations.log");
const ADDRESSES_PATH   = path.join(DATA_DIR, "addresses.json");
const SESSIONS_PATH    = path.join(DATA_DIR, "sessions.json");
const STOCK_LOG        = path.join(DATA_DIR, "stock.log");
const NOTIFY_STATE_PATH= path.join(DATA_DIR, "notify_state.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ADDRESSES_PATH)) fs.writeFileSync(ADDRESSES_PATH, JSON.stringify({}, null, 2));
if (!fs.existsSync(SESSIONS_PATH)) fs.writeFileSync(SESSIONS_PATH, JSON.stringify({}, null, 2));
if (!fs.existsSync(NOTIFY_STATE_PATH)) fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify({}, null, 2));

if (!fs.existsSync(PRODUCTS_PATH)) {
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify([
    { id:"kusuke-250", name:"久助（えびせん）", price:250, stock:20, desc:"お得な割れせん。" },
    { id:"nori-akasha-340", name:"のりあかしゃ", price:340, stock:20, desc:"海苔の風味豊かなえびせんべい" },
    { id:"uzu-akasha-340",  name:"うずあかしゃ", price:340, stock:10, desc:"渦を巻いたえびせんべい" },
    { id:"matsu-akasha-340",name:"松あかしゃ", price:340, stock:30, desc:"海老をたっぷり使用した高級えびせんべい" },
  ], null, 2));
}

// ====== Utils ======
const client = new line.Client(config);
const safeJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p,"utf8")); } catch { return fb; } };
const readProducts = () => safeJSON(PRODUCTS_PATH, []);
const writeProducts = (v) => fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(v,null,2));
const readAddresses = () => safeJSON(ADDRESSES_PATH, {});
const writeAddresses = (v) => fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(v,null,2));
const readSessions = () => safeJSON(SESSIONS_PATH, {});
const writeSessions = (v) => fs.writeFileSync(SESSIONS_PATH, JSON.stringify(v,null,2));
const yen = (n) => `${Number(n).toLocaleString("ja-JP")}円`;

// ====== Payment & Shipping ======
const SHIPPING_BY_REGION = {
  "北海道":1100,"東北":900,"関東":800,"中部":800,"近畿":900,"中国":1000,"四国":1000,"九州":1100,"沖縄":1400
};
const COD_FEE = 330;
// ====== Flex Builders ======
function qstr(obj) {
  return Object.entries(obj).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

function productsFlex(list) {
  const bubbles = list.filter(p => p.id !== "kusuke-250").map(p => ({
    type:"bubble",
    body:{ type:"box", layout:"vertical", spacing:"sm", contents:[
      { type:"text", text:p.name, weight:"bold", size:"md", wrap:true },
      { type:"text", text:`価格：${yen(p.price)}　在庫：${p.stock}`, size:"sm", wrap:true },
      p.desc ? { type:"text", text:p.desc, size:"sm", wrap:true } : { type:"box", layout:"vertical", contents:[] }
    ] },
    footer:{ type:"box", layout:"vertical", spacing:"md", contents:[
      { type:"button", style:"primary", action:{ type:"postback", label:"数量を選ぶ", data:`order_qty?${qstr({id:p.id,qty:1})}` } }
    ]}
  }));

  // その他（自由入力）
  bubbles.push({
    type:"bubble",
    body:{ type:"box", layout:"vertical", spacing:"sm", contents:[
      { type:"text", text:"その他（自由入力）", weight:"bold", size:"md" },
      { type:"text", text:"商品名と個数だけでOK。価格入力不要。", size:"sm", wrap:true }
    ] },
    footer:{ type:"box", layout:"vertical", spacing:"md", contents:[
      { type:"button", style:"primary", action:{ type:"postback", label:"商品名を入力", data:"other_start" } },
      { type:"button", style:"secondary", action:{ type:"postback", label:"← 戻る", data:"order_back" } },
    ]}
  });

  return { type:"flex", altText:"商品一覧", contents:{ type:"carousel", contents:bubbles }};
}

function qtyFlex(id, qty){
  const q=Math.max(1,Math.min(99,Number(qty)||1));
  return {
    type:"flex", altText:"数量選択",
    contents:{ type:"bubble",
      body:{ type:"box", layout:"vertical", spacing:"md", contents:[
        { type:"text", text:"数量選択", weight:"bold", size:"lg" },
        { type:"text", text:`現在：${q}個`, size:"md" }
      ]},
      footer:{ type:"box", layout:"vertical", spacing:"md", contents:[
        { type:"button", style:"secondary", action:{ type:"postback", label:"-1", data:`order_qty?${qstr({id,qty:q-1})}` }},
        { type:"button", style:"secondary", action:{ type:"postback", label:"+1", data:`order_qty?${qstr({id,qty:q+1})}` }},
        { type:"button", style:"primary", action:{ type:"postback", label:"受取方法へ", data:`order_method?${qstr({id,qty:q})}` }},
        { type:"button", style:"secondary", action:{ type:"postback", label:"← 商品一覧", data:"order_back" }}
      ]}
    }
  };
}

function methodFlex(id, qty){
  return {
    type:"flex", altText:"受取方法",
    contents:{ type:"bubble",
      body:{ type:"box", layout:"vertical", spacing:"md", contents:[
        { type:"text", text:"受取方法", weight:"bold", size:"lg" }
      ]},
      footer:{ type:"box", layout:"horizontal", spacing:"md", contents:[
        { type:"button", style:"primary", action:{ type:"postback", label:"宅配", data:`order_region?${qstr({id,qty,method:"delivery"})}` }},
        { type:"button", style:"secondary", action:{ type:"postback", label:"店頭受取", data:`order_payment?${qstr({id,qty,method:"pickup",region:"-"})}` }}
      ]}
    }
  };
}

function regionFlex(id, qty){
  const rows=[];
  const regions=Object.keys(SHIPPING_BY_REGION);
  for(let i=0;i<regions.length;i+=2){
    rows.push({
      type:"box", layout:"horizontal", spacing:"md",
      contents: regions.slice(i,i+2).map(r=>({
        type:"button", style:"secondary",
        action:{ type:"postback", label:`${r}（${yen(SHIPPING_BY_REGION[r])}）`, data:`order_payment?${qstr({id,qty,method:"delivery",region:r})}` }
      }))
    });
  }
  return {
    type:"flex", altText:"地域選択",
    contents:{ type:"bubble",
      body:{ type:"box", layout:"vertical", spacing:"md", contents:[
        { type:"text", text:"送料地域", weight:"bold", size:"lg" }
      ]},
      footer:{ type:"box", layout:"vertical", spacing:"sm", contents:rows }
    }
  };
}

function paymentFlex(id, qty, method, region){
  if(method==="pickup"){
    return {
      type:"flex", altText:"店頭支払い",
      contents:{ type:"bubble",
        body:{ type:"box", layout:"vertical", spacing:"md", contents:[
          { type:"text", text:"店頭受取（磯屋）", weight:"bold", size:"lg" },
          { type:"text", text:"お受け取り時にお名前をお伺いします。", wrap:true }
        ]},
        footer:{ type:"box", layout:"vertical", spacing:"md", contents:[
          { type:"button", style:"primary",
            action:{ type:"postback", label:"現金で支払う", data:`order_confirm_view?${qstr({id,qty,method:"pickup",region:"",payment:"cash"})}` }},
          { type:"button", style:"secondary", action:{ type:"postback", label:"← 戻る", data:`order_method?${qstr({id,qty})}` }}
        ]}
      }
    };
  }

  return {
    type:"flex", altText:"支払い方法",
    contents:{ type:"bubble",
      body:{ type:"box", layout:"vertical", spacing:"md", contents:[
        { type:"text", text:"宅配支払い方法", weight:"bold", size:"lg" }
      ]},
      footer:{ type:"box", layout:"horizontal", spacing:"md", contents:[
        { type:"button", style:"primary", action:{ type:"postback", label:`代引（+${yen(COD_FEE)})`, data:`order_confirm_view?${qstr({id,qty,method,region,payment:"cod"})}` }},
        { type:"button", style:"secondary", action:{ type:"postback", label:"銀行振込", data:`order_confirm_view?${qstr({id,qty,method,region,payment:"bank"})}` }}
      ]}
    }
  };
}
// ====== 最終確認Flex ======
function confirmFlex(product, qty, method, region, payment){
  const regionFee = method==="delivery" ? (SHIPPING_BY_REGION[region]||0) : 0;
  const codFee = payment==="cod" ? COD_FEE : 0;
  const subtotal = product.price * qty;
  const total = subtotal + regionFee + codFee;

  return {
    type:"flex", altText:"注文確認",
    contents:{ type:"bubble",
      body:{ type:"box", layout:"vertical", spacing:"md", contents:[
        { type:"text", text:"最終確認", weight:"bold", size:"lg" },
        { type:"text", text:`商品：${product.name}`, wrap:true },
        { type:"text", text:`数量：${qty}個` },
        { type:"text", text:`小計：${yen(subtotal)}` },
        { type:"text", text:`送料：${yen(regionFee)}` },
        { type:"text", text:`代引：${yen(codFee)}` },
        { type:"text", text:`合計：${yen(total)}`, weight:"bold" }
      ]},
      footer:{ type:"box", layout:"vertical", spacing:"md", contents:[
        (method==="delivery" ? {
          type:"button", style:"secondary",
          action:{ type:"uri", label:"住所入力（LIFF）", uri:`https://liff.line.me/${LIFF_ID}?from=address` }
        } : { type:"box", layout:"vertical", contents:[] }),
        { type:"button", style:"primary", action:{ type:"postback", label:"確定する", data:`order_finish?${qstr({id:product.id,qty,method,region,payment})}` }},
        { type:"button", style:"secondary", action:{ type:"postback", label:"← 戻る", data:"order_back" }}
      ]}
    }
  };
}

// ====== Webhook ======
app.post("/webhook", line.middleware(config), async (req, res)=>{
  const events=req.body.events||[];
  for(const ev of events) await handleEvent(ev);
  res.status(200).end();
});

// ====== Event ======
async function handleEvent(ev){
  const uid = ev.source?.userId;
  const sessions = readSessions();

  // ---- Text Message ----
  if(ev.type==="message" && ev.message.type==="text"){
    const text=ev.message.text.trim();

    // ★ 久助 形式入力
    const m = /^久助(?:\s+(\d+))?$/i.exec(text);
    if(m){
      if(!m[1]){
        sessions[uid]={await:"kusukeQty"};
        writeSessions(sessions);
        return client.replyMessage(ev.replyToken,{type:"text",text:"久助の個数を半角数字で入力してください。例：2"});
      }
      const qty=Math.max(1,Math.min(99,Number(m[1])));
      return client.replyMessage(ev.replyToken, methodFlex("kusuke-250",qty));
    }
    if(sessions[uid]?.await==="kusukeQty"){
      if(!/^\d+$/.test(text)) return client.replyMessage(ev.replyToken,{type:"text",text:"半角数字で入力してください。"});
      const qty=Math.max(1,Math.min(99,Number(text)));
      delete sessions[uid]; writeSessions(sessions);
      return client.replyMessage(ev.replyToken, methodFlex("kusuke-250",qty));
    }

    // ★ その他
    if(sessions[uid]?.await==="otherName"){
      const name=text.slice(0,50);
      sessions[uid]={await:"otherQty",temp:{name}};
      writeSessions(sessions);
      return client.replyMessage(ev.replyToken,{type:"text",text:`「${name}」ですね。個数を入力してください。`});
    }
    if(sessions[uid]?.await==="otherQty"){
      if(!/^\d+$/.test(text)) return client.replyMessage(ev.replyToken,{type:"text",text:"半角数字で入力してください。"});
      const qty=Math.max(1,Math.min(99,Number(text)));
      const name=sessions[uid].temp.name;
      delete sessions[uid]; writeSessions(sessions);
      const id=`other:${encodeURIComponent(name)}:0`;
      return client.replyMessage(ev.replyToken, methodFlex(id,qty));
    }

    // 通常導線
    if(text==="直接注文"){
      return client.replyMessage(ev.replyToken, productsFlex(readProducts()));
    }

    return client.replyMessage(ev.replyToken,{type:"text",text:`・久助は「久助 2」\n・その他は「直接注文」→「その他」`});
  }

  // ---- Postback ----
  if(ev.type==="postback"){
    const data=ev.postback.data;

    if(data==="other_start"){
      sessions[uid]={await:"otherName"};
      writeSessions(sessions);
      return client.replyMessage(ev.replyToken,{type:"text",text:"商品名を入力してください。"});
    }

    if(data.startsWith("order_qty?")){
      const {id,qty}=Object.fromEntries(new URLSearchParams(data.split("?")[1]));
      return client.replyMessage(ev.replyToken, qtyFlex(id,qty));
    }
    if(data.startsWith("order_method?")){
      const {id,qty}=Object.fromEntries(new URLSearchParams(data.split("?")[1]));
      return client.replyMessage(ev.replyToken, methodFlex(id,qty));
    }
    if(data.startsWith("order_region?")){
      const p=Object.fromEntries(new URLSearchParams(data.split("?")[1]));
      return client.replyMessage(ev.replyToken, regionFlex(p.id,p.qty));
    }
    if(data.startsWith("order_payment?")){
      const p=Object.fromEntries(new URLSearchParams(data.split("?")[1]));
      return client.replyMessage(ev.replyToken, paymentFlex(p.id,p.qty,p.method,p.region));
    }
    if(data.startsWith("order_confirm_view?")){
      const p=Object.fromEntries(new URLSearchParams(data.split("?")[1]));
      const products=readProducts();
      let product = products.find(x=>x.id===p.id);
      if(!product){ product={id:p.id,name:"その他",price:0}; }
      return client.replyMessage(ev.replyToken, confirmFlex(product,Number(p.qty),p.method,p.region,p.payment));
    }

    // ====== 最終確定 ======
    if(data.startsWith("order_finish?")){
      const p=Object.fromEntries(new URLSearchParams(data.split("?")[1]));
      const products=readProducts();
      const idx=products.findIndex(x=>x.id===p.id);
      let product=idx>=0?products[idx]:{id:p.id,name:"その他",price:0,stock:Infinity};

      const need=Number(p.qty);
      if(idx>=0 && product.stock<need){
        // 予約
        fs.appendFileSync(RESERVATIONS_LOG,JSON.stringify({ts:new Date(),userId:uid,productId:p.id,qty:need})+"\n");
        return client.replyMessage(ev.replyToken,{type:"text",text:`予約を受け付けました。\n商品：${product.name}\n数量：${need}個\n入荷次第ご案内します。`});
      }

      if(idx>=0){
        products[idx].stock -= need;
        writeProducts(products);
      }

      const regionFee = p.method==="delivery" ? (SHIPPING_BY_REGION[p.region]||0) : 0;
      const codFee = p.payment==="cod" ? COD_FEE : 0;
      const subtotal = product.price * need;
      const total = subtotal + regionFee + codFee;

      fs.appendFileSync(ORDERS_LOG,JSON.stringify({ts:new Date(),userId:uid,productId:p.id,qty:need,total})+"\n");

      // Reply to user
      await client.replyMessage(ev.replyToken,{type:"text",text:
`ご注文ありがとうございます！
商品：${product.name}
数量：${need}個
合計：${yen(total)}
受取：${p.method==="pickup"?"店頭（磯屋）":"宅配"}
`
      });

      // 銀行振込案内
      if(p.method==="delivery" && p.payment==="bank"){
        const msg = (BANK_INFO||"銀行口座は後ほどご案内いたします。") + (BANK_NOTE?`\n\n${BANK_NOTE}`:"");
        await client.pushMessage(uid,{type:"text",text:msg});
      }
    }
  }
}

// ====== Health ======
app.get("/health",(_req,res)=>res.send("OK"));

// ====== Listen ======
app.listen(PORT,()=>console.log("🚀磯屋 BOT running:",PORT));
