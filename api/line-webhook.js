// Vercel Serverless Function: LINE Messaging API Webhook for HouseClean Hub
const crypto = require('crypto');
const { mutateCloudState, readCloudState, getNowJST, getTodayYMDJST } = require('./_github-db');
const { parseOrderPdfBuffer } = require('./_pdf-parser');

const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || 'https://frs0882-byte.github.io/houseclean-hub/';

// 生リクエストボディを読み込むヘルパー
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && Buffer.isBuffer(req.body)) return resolve(req.body);
    if (typeof req.body === 'string') return resolve(Buffer.from(req.body, 'utf8'));
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// LINE署名検証
function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!channelSecret || !signature) return false;
  const hash = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  return hash === signature;
}

// LINE Messaging API Reply
async function replyLineMessage(replyToken, messages, accessToken) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ replyToken, messages })
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('LINE Reply failed:', res.status, errText);
  }
}

// LINE Content API からバイナリファイルを取得
async function downloadLineContent(messageId, accessToken) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to download LINE content: ${res.status} ${res.statusText}`);
  }
  return await res.arrayBuffer();
}

// 完了Flex Messageの組み立て
function buildProjectRegisteredFlex(project, parsed) {
  const workItemsText = (project.workItems || []).length > 0
    ? project.workItems.slice(0, 6).map(wi => `・${wi.itemName} (${wi.quantity}${wi.unit})`).join('\n')
    : '・明細はアプリ内で確認/追加してください';

  return {
    type: 'flex',
    altText: `✅ 【自動登録完了】${project.name} (納期: ${project.dueDate})`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#059669',
        paddingAll: '14px',
        contents: [
          {
            type: 'text',
            text: '✅ 案件ボックスに自動登録しました',
            color: '#ffffff',
            weight: 'bold',
            size: 'sm'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: project.name,
            weight: 'bold',
            size: 'lg',
            wrap: true,
            color: '#0f172a'
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            backgroundColor: '#f8fafc',
            paddingAll: '12px',
            cornerRadius: '10px',
            contents: [
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  { type: 'text', text: '工期・納期', color: '#64748b', size: 'xs', flex: 2 },
                  { type: 'text', text: `${project.startDate} 〜 ${project.dueDate}`, weight: 'bold', color: '#4f46e5', size: 'xs', flex: 5, wrap: true }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  { type: 'text', text: '現場住所', color: '#64748b', size: 'xs', flex: 2 },
                  { type: 'text', text: project.address || '未登録', color: '#334155', size: 'xs', flex: 5, wrap: true }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  { type: 'text', text: '元請金額', color: '#64748b', size: 'xs', flex: 2 },
                  { type: 'text', text: `¥${(project.clientAmount || 0).toLocaleString()} (税込目安)`, weight: 'bold', color: '#059669', size: 'xs', flex: 5 }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  { type: 'text', text: '鍵・入館', color: '#64748b', size: 'xs', flex: 2 },
                  { type: 'text', text: parsed.keyInfo || 'PDF参照', color: '#e11d48', size: 'xs', flex: 5, wrap: true }
                ]
              }
            ]
          },
          {
            type: 'text',
            text: `🛠️ 抽出明細 (${(project.workItems || []).length}件):`,
            weight: 'bold',
            size: 'xs',
            color: '#334155'
          },
          {
            type: 'text',
            text: workItemsText,
            size: 'xs',
            color: '#475569',
            wrap: true
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#4f46e5',
            action: {
              type: 'uri',
              label: '📅 カレンダー・業者割当を開く',
              uri: APP_PUBLIC_URL
            }
          }
        ]
      }
    }
  };
}

// Vercel handler
async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', service: 'HouseClean Hub LINE Bot Webhook' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!channelSecret || !accessToken) {
    console.error('LINE_CHANNEL_SECRET or LINE_CHANNEL_ACCESS_TOKEN is missing.');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'Failed to read request body' });
  }

  const signature = req.headers['x-line-signature'];
  if (!verifyLineSignature(rawBody, signature, channelSecret)) {
    console.warn('Invalid LINE signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const events = body.events || [];
  if (events.length === 0) {
    return res.status(200).json({ status: 'ok', message: 'Webhook verification passed' });
  }

  const colorsPalette = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'];

  for (const event of events) {
    if (event.type !== 'message') continue;
    const { message, replyToken } = event;

    try {
      // 1. ファイル受信 (PDFチェック)
      if (message.type === 'file') {
        const fileName = message.fileName || 'document.pdf';
        if (!fileName.toLowerCase().endsWith('.pdf')) {
          await replyLineMessage(replyToken, [{
            type: 'text',
            text: `📄「${fileName}」を受信しましたが、PDFファイルではありません。\n工事依頼書の【PDFファイル】を転送してください！`
          }], accessToken);
          continue;
        }

        // LINEサーバーからPDFダウンロード
        const arrayBuffer = await downloadLineContent(message.id, accessToken);
        const todayYMD = getTodayYMDJST();

        // PDF解析実行
        const parsed = await parseOrderPdfBuffer(arrayBuffer, fileName, todayYMD);

        // 新規案件オブジェクトを生成
        const newProjectId = 'proj_line_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const color = colorsPalette[Math.floor(Math.random() * colorsPalette.length)];
        const notesText = [
          parsed.keyInfo ? `【鍵情報】${parsed.keyInfo}` : '',
          `【LINE自動登録】元ファイル: ${fileName} (${getNowJST()})`
        ].filter(Boolean).join('\n');

        const newProject = {
          id: newProjectId,
          name: parsed.name,
          address: parsed.address,
          startDate: parsed.startDate || todayYMD,
          dueDate: parsed.dueDate || todayYMD,
          status: 'inbox', // 案件ボックス(未割当)として登録
          color: color,
          notes: notesText,
          materials: parsed.materials,
          client: parsed.client,
          clientAmount: parsed.clientAmount || 0,
          contractorCloth: '',
          contractorClean: '',
          workItems: parsed.workItems || [],
          checklist: [
            { id: 'c1', label: '現地確認', mark: '確認', completed: false },
            { id: 'c2', label: '業者手配', mark: '発注', completed: false },
            { id: 'c3', label: '施工完了', mark: '作業', completed: false },
            { id: 'c4', label: '写真報告', mark: '報告', completed: false }
          ],
          source: 'line-bot',
          createdAt: getNowJST()
        };

        // Cloud DB へ書き込み
        await mutateCloudState((state) => {
          if (!Array.isArray(state.projects)) state.projects = [];
          state.projects.unshift(newProject);

          if (!Array.isArray(state.lineLogs)) state.lineLogs = [];
          state.lineLogs.unshift({
            timestamp: getNowJST(),
            fileName: fileName,
            projectName: newProject.name,
            dueDate: newProject.dueDate,
            itemsCount: newProject.workItems.length,
            projectId: newProjectId
          });
          if (state.lineLogs.length > 50) state.lineLogs = state.lineLogs.slice(0, 50);

          return state;
        }, `LINE Bot auto-registered project: ${newProject.name}`);

        // LINE へ完了カードを返信
        const flexMsg = buildProjectRegisteredFlex(newProject, parsed);
        await replyLineMessage(replyToken, [flexMsg], accessToken);
      }

      // 2. 画像受信時
      else if (message.type === 'image') {
        await replyLineMessage(replyToken, [{
          type: 'text',
          text: '📷 画像を受信しました！\n自動解析による案件登録は、元請けから届く【PDFファイル】をそのまま転送していただくと完了します。\n\n👉 ツールを開く:\n' + APP_PUBLIC_URL
        }], accessToken);
      }

      // 3. テキストメッセージ（コマンド応答）
      else if (message.type === 'text') {
        const text = (message.text || '').trim();
        if (/(一覧|予定|案件|状況|リスト)/.test(text)) {
          const { state } = await readCloudState();
          const active = (state.projects || []).slice(0, 5);
          if (active.length === 0) {
            await replyLineMessage(replyToken, [{
              type: 'text',
              text: '📭 現在クラウドに登録されている案件はありません。\n工事依頼書のPDFをこのトークに転送すると自動で登録されます！\n\n👉 ' + APP_PUBLIC_URL
            }], accessToken);
          } else {
            const listStr = active.map((p, i) => `${i + 1}. ${p.name}\n   📅 ${p.startDate} 〜 ${p.dueDate} (${(p.workItems || []).length}項目)`).join('\n\n');
            await replyLineMessage(replyToken, [{
              type: 'text',
              text: `📋 【最新の登録案件 (${active.length}件)】\n\n${listStr}\n\n👉 カレンダーを開く:\n${APP_PUBLIC_URL}`
            }], accessToken);
          }
        } else {
          await replyLineMessage(replyToken, [{
            type: 'text',
            text: `🏠 【HouseClean Hub 連携Bot】\n\n元請けから届いた工事依頼書【PDFファイル】を、このトークにそのまま転送してください！自動で案件ボックス＆カレンダーに登録されます。\n\n💡「一覧」と送ると登録中の最新案件を確認できます。\n👉 アプリを開く:\n${APP_PUBLIC_URL}`
          }], accessToken);
        }
      }
    } catch (err) {
      console.error('Error processing LINE event:', err);
      await replyLineMessage(replyToken, [{
        type: 'text',
        text: `⚠️ PDFの読み込み中にエラーが発生しました。\n(${err.message})\n手動でアプリから登録する場合はこちら:\n${APP_PUBLIC_URL}`
      }], accessToken);
    }
  }

  return res.status(200).json({ status: 'ok' });
}

handler.config = {
  api: {
    bodyParser: false
  }
};

module.exports = handler;
