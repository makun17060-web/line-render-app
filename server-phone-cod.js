// server-phone-cod.js
// -----------------------------------------------------
// 住所登録 LIFF + Twilio 音声電話（代引き）連携サンプル
// ・/public 以下に phone-address.html を配置
// ・/api/address/register で住所を保存
// ・/twilio/cod/start で発信者電話番号から住所を引き当てて案内
// -----------------------------------------------------

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------
// 共通設定
// ----------------------
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// 静的ファイル（LIFF ページなど）
app.use('/public', express.static(path.join(__dirname, 'public')));

// データファイル
const DATA_DIR = path.join(__dirname, 'data');
const ADDRESSES_FILE = path.join(DATA_DIR, 'addresses.json');

// ----------------------
// ユーティリティ
// ----------------------

// JSON ファイル読込（なければ defaultValue を返す）
async function loadJSON(filePath, defaultValue) {
  try {
    const txt = await fs.readFile(filePath, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return defaultValue;
    }
    console.error('loadJSON error:', filePath, err);
    throw err;
  }
}

// JSON ファイル保存
async function saveJSON(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const txt = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, txt, 'utf8');
}

// 電話番号の正規化
// Twilio の From（+8190...）と、ユーザー入力（090... or +8190...）を
// 同じキーになるようにそろえる
function normalizePhoneForKey(raw) {
  if (!raw) return '';

  let p = String(raw).trim();

  // 数字と + 以外を削除
  p = p.replace(/[^\d+]/g, '');

  // 例: 09012345678 → +819012345678 （日本の携帯/固定想定）
  if (!p.startsWith('+') && p.startsWith('0') && (p.length === 10 || p.length === 11)) {
    p = '+81' + p.slice(1);
  }

  // + も 0 も付いていない数字列（海外など）の場合は先頭に + を足すだけ
  if (!p.startsWith('+') && /^\d{8,15}$/.test(p)) {
    p = '+' + p;
  }

  return p;
}

// ----------------------
// 住所登録 API（LIFF から呼び出し）
// ----------------------
//
// 期待するリクエストボディ:
// {
//   lineUserId: "...",  // 任意
//   name: "磯屋 太郎",
//   phone: "09012345678" または "+819012345678",
//   zip: "4411234",
//   prefecture: "愛知県",
//   address1: "豊橋市○○町1-2-3",
//   address2: "○○マンション101号室",
//   memo: "備考"
// }
//
app.post('/api/address/register', async (req, res) => {
  try {
    const {
      lineUserId,
      name,
      phone,
      zip,
      prefecture,
      address1,
      address2,
      memo,
    } = req.body || {};

    if (!name || !phone || !zip || !prefecture || !address1) {
      return res.status(400).json({
        ok: false,
        error: '必須項目が不足しています。（name, phone, zip, prefecture, address1）',
      });
    }

    const keyPhone = normalizePhoneForKey(phone);
    if (!keyPhone) {
      return res.status(400).json({ ok: false, error: '電話番号の形式を確認してください。' });
    }

    const addresses = await loadJSON(ADDRESSES_FILE, {});

    addresses[keyPhone] = {
      lineUserId: lineUserId || null,
      name,
      phone: keyPhone, // 正規化済み
      zip,
      prefecture,
      address1,
      address2: address2 || '',
      memo: memo || '',
      updatedAt: new Date().toISOString(),
    };

    await saveJSON(ADDRESSES_FILE, addresses);

    console.log('[address.register] saved for phone =', keyPhone);

    return res.json({ ok: true });
  } catch (err) {
    console.error('/api/address/register error:', err);
    return res.status(500).json({ ok: false, error: 'サーバーエラーが発生しました。' });
  }
});

// ----------------------
// Twilio 連携（電話注文用）
// ----------------------
//
// Twilio の「音声」→ 受電URL に以下を設定:
//   https://your-domain/twilio/cod/start
// ----------------------

// 着信開始
app.post('/twilio/cod/start', async (req, res) => {
  try {
    const fromRaw = req.body.From || ''; // 例: "+819012345678"
    const from = normalizePhoneForKey(fromRaw);

    console.log('[twilio.cod.start] From =', fromRaw, '-> key =', from);

    const addresses = await loadJSON(ADDRESSES_FILE, {});
    const addr = addresses[from];

    let twiml = '';

    if (addr) {
      // 住所が見つかった場合 → 確認＆商品選択へ
      const fullAddress =
        `${addr.prefecture || ''}${addr.address1 || ''}${addr.address2 || ''}`.trim();

      twiml = `
<Response>
  <Say language="ja-JP" voice="alice">
    お電話ありがとうございます。手造りえびせんべい、磯屋です。
  </Say>
  <Say language="ja-JP" voice="alice">
    いつもありがとうございます。
    お届け先は、${fullAddress} でよろしいでしょうか。
    よろしければ 1 を、変更する場合は 2 を押してください。
  </Say>
  <Gather input="dtmf" numDigits="1" timeout="10" action="/twilio/cod/address-confirm" method="POST">
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。お手数ですが、もう一度おかけ直しください。
  </Say>
  <Hangup/>
</Response>`.trim();
    } else {
      // 住所が登録されていない場合 → LINE から住所登録を案内して終了
      twiml = `
<Response>
  <Say language="ja-JP" voice="alice">
    お電話ありがとうございます。手造りえびせんべい、磯屋です。
  </Say>
  <Say language="ja-JP" voice="alice">
    大変おそれいりますが、
    お届け先の住所がまだ登録されていません。
    LINE のトーク画面から 「住所登録」 をタップして、
    住所と電話番号の登録をお願いいたします。
  </Say>
  <Say language="ja-JP" voice="alice">
    その後、もう一度お電話いただければ、ご注文をお受けできます。
  </Say>
  <Hangup/>
</Response>`.trim();
    }

    res.type('text/xml').send(twiml);
  } catch (err) {
    console.error('/twilio/cod/start error:', err);
    const twiml = `
<Response>
  <Say language="ja-JP" voice="alice">
    システムエラーが発生しました。時間をおいておかけ直しください。
  </Say>
  <Hangup/>
</Response>`.trim();
    res.type('text/xml').send(twiml);
  }
});

// 住所確認の結果（1: OK / 2: 変更したい）
app.post('/twilio/cod/address-confirm', async (req, res) => {
  const digits = (req.body.Digits || '').trim();
  const fromRaw = req.body.From || '';
  const from = normalizePhoneForKey(fromRaw);

  console.log('[twilio.cod.address-confirm] From =', from, 'Digits =', digits);

  let twiml = '';

  if (digits === '1') {
    // 住所OK → 商品選択へ進む（ここはお好みで拡張）
    twiml = `
<Response>
  <Say language="ja-JP" voice="alice">
    ありがとうございます。それでは商品をお選びください。
    久助は 1 を、四角のりせんは 2 を、プレミアムえびせんは 3 を押してください。
  </Say>
  <Gather input="dtmf" numDigits="1" timeout="10" action="/twilio/cod/product" method="POST">
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。お手数ですが、もう一度おかけ直しください。
  </Say>
  <Hangup/>
</Response>`.trim();
  } else if (digits === '2') {
    // 住所変更希望 → 今回の電話では受けず、LINEからの再登録を案内
    twiml = `
<Response>
  <Say language="ja-JP" voice="alice">
    住所の変更をご希望ですね。
    お手数ですが、一度通話をお切りいただき、
    LINE のトーク画面から 「住所登録」 をタップして、
    新しい住所を登録してください。
  </Say>
  <Say language="ja-JP" voice="alice">
    登録後に、もう一度お電話いただければ、新しい住所でご注文をお受けします。
  </Say>
  <Hangup/>
</Response>`.trim();
  } else {
    twiml = `
<Response>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。お手数ですが、もう一度おかけ直しください。
  </Say>
  <Hangup/>
</Response>`.trim();
  }

  res.type('text/xml').send(twiml);
});

// ★ここから先は、商品選択や数量、最終確認など、既存の COD フローを
//   /twilio/cod/product 以降に追加していってください。
//   （今はダミー実装）

app.post('/twilio/cod/product', (req, res) => {
  const digits = (req.body.Digits || '').trim();
  console.log('[twilio.cod.product] Digits =', digits);

  const productName =
    digits === '1' ? '久助' :
    digits === '2' ? '四角のりせん' :
    digits === '3' ? 'プレミアムえびせん' :
    'ご指定の商品';

  const twiml = `
<Response>
  <Say language="ja-JP" voice="alice">
    ${productName} をお選びいただきました。
    このあとの数量指定や詳細については、今後のフローに合わせて実装してください。
  </Say>
  <Say language="ja-JP" voice="alice">
    テスト用のサンプルのため、ここで通話を終了します。
  </Say>
  <Hangup/>
</Response>`.trim();

  res.type('text/xml').send(twiml);
});

// ----------------------
// 動作確認用
// ----------------------
app.get('/healthz', (req, res) => {
  res.json({ ok: true, message: 'server-phone-cod is running' });
});

// ----------------------
// 起動
// ----------------------
app.listen(PORT, () => {
  console.log(`server-phone-cod listening on port ${PORT}`);
});
