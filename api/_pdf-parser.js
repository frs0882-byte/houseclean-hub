// Server-side High-Precision PDF Order Parser for HouseClean Hub (Node.js)
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// Vercel/Serverless環境でのWorker解決エラーを防ぐためインプロセスWorkerを注入
try {
  if (!globalThis.pdfjsWorker) {
    globalThis.pdfjsWorker = require('pdfjs-dist/legacy/build/pdf.worker.js');
  }
} catch (e) {
  console.warn('In-process pdfjsWorker preload skipped:', e.message);
}

// 汎用アイテムIDマッピング（app.js と完全互換）
function resolveWorkItemId(desc, typeHint = '') {
  const d = (desc || '').trim();
  const t = (typeHint || '').trim();

  if (/木巾木/i.test(d)) return 'baseboard_wood';
  if (/(フロアタイル|フロア|塩ビタイル|長尺シート|フロアー)/i.test(d)) return 'floor';
  if (t === 'baseboard_soft' || /(巾木|ソフト巾木)/i.test(d)) return 'baseboard_soft';
  if (t === 'cf' || /(CF|クッションフロア|ＣＦ)/i.test(d)) return 'cf';
  if (/(エアコン|クーラー)/i.test(d)) return 'aircon';
  if (/洗面台/i.test(d)) return 'washbasin';
  if (/網戸/i.test(d)) return 'screen_door';
  if (/(ボード補修|石膏ボード|穴補修)/i.test(d)) return 'board_repair';
  if (t === 'cleaning' || /(クリーニング|清掃|美装|ハウスクリーニング)/i.test(d)) return 'cleaning';
  if (t === 'cloth' || /(クロス|壁紙|貼替|アクセント)/i.test(d)) return 'cloth';
  return 'cloth';
}

// 工事依頼書PDFバイナリ解析メイン
async function parseOrderPdfBuffer(pdfBuffer, fileName = 'document.pdf', defaultTodayYMD = '') {
  const typedArray = new Uint8Array(pdfBuffer);
  const loadingTask = pdfjsLib.getDocument({
    data: typedArray,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0
  });

  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  const allItems = [];
  let fullTextLines = [];

  for (let pNum = 1; pNum <= Math.min(numPages, 3); pNum++) {
    const page = await pdf.getPage(pNum);
    const textContent = await page.getTextContent();
    const pageItems = [];

    for (const item of textContent.items) {
      const txt = (item.str || '').trim();
      if (!txt) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const obj = { text: txt, x, y, width: item.width || 0, page: pNum };
      allItems.push(obj);
      pageItems.push(obj);
    }

    // Y座標でグルーピングしてテキスト行を再構築
    const linesMap = {};
    for (const it of pageItems) {
      let matchedY = null;
      for (const gy of Object.keys(linesMap)) {
        if (Math.abs(parseFloat(gy) - it.y) <= 5) {
          matchedY = gy;
          break;
        }
      }
      if (!matchedY) {
        matchedY = String(it.y);
        linesMap[matchedY] = [];
      }
      linesMap[matchedY].push(it);
    }
    const sortedYs = Object.keys(linesMap).sort((a, b) => parseFloat(b) - parseFloat(a));
    for (const gy of sortedYs) {
      const grp = linesMap[gy].sort((a, b) => a.x - b.x);
      fullTextLines.push({
        y: parseFloat(gy),
        page: pNum,
        items: grp,
        text: grp.map(i => i.text).join(' ')
      });
    }
  }

  const page1Items = allItems.filter(i => i.page === 1);
  const allText = fullTextLines.map(l => l.text).join('\n');

  // 1. 物件名抽出（座標優先 ➔ 汎用キーワード ➔ ファイル名）
  let name = '';
  for (const it of page1Items) {
    if (it.y >= 635 && it.y <= 670 && it.x < 280) {
      if (/(号室|マンション|ハイツ|メゾン|コーポ|レジデンス|エスタート|ルネサンス|フラッツ|ヴィラ|nido)/i.test(it.text)) {
        name = it.text;
        break;
      }
    }
  }
  if (!name) {
    for (const line of fullTextLines) {
      const m = line.text.match(/(?:物件名|現場名|工事名称)[：:\s]*(.+)/);
      if (m && m[1]) {
        name = m[1].trim();
        break;
      }
    }
  }
  if (!name) {
    for (const it of page1Items) {
      if (/\d+号室?$/.test(it.text) && it.text.length >= 4 && it.text.length <= 40) {
        name = it.text;
        break;
      }
    }
  }
  if (!name) {
    name = fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
  }

  // 2. 住所抽出
  let address = '';
  for (const it of page1Items) {
    if (it.y >= 615 && it.y <= 645 && it.x < 280) {
      if (/[都道府県区市町丁目番]/.test(it.text) && !it.text.includes('南千住')) {
        address = it.text;
        break;
      }
    }
  }
  if (!address) {
    const addrMatch = allText.match(/(?:東京都|北海道|(?:京都|大阪)府|.{2,3}県)[^\s\n]{4,35}/);
    if (addrMatch && !addrMatch[0].includes('荒川区南千住')) {
      address = addrMatch[0].trim();
    }
  }

  // 3. 納期（工事完了日）抽出
  let dueDate = '';
  for (const line of fullTextLines) {
    if (/(完了日|納期|引渡|完工)/.test(line.text)) {
      const m = line.text.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/);
      if (m) {
        dueDate = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
        break;
      }
    }
  }
  if (!dueDate) {
    for (const it of page1Items) {
      const m = it.text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
      if (m) {
        dueDate = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
        break;
      }
    }
  }
  if (!dueDate && defaultTodayYMD) {
    // 見つからない場合は登録日の5日後を仮納期に
    const d = new Date(defaultTodayYMD);
    d.setDate(d.getDate() + 5);
    dueDate = d.toISOString().slice(0, 10);
  }

  // 4. 鍵情報抽出
  let keyInfo = '';
  for (const line of fullTextLines) {
    if (/(AL[：:]|呼[：:]|ｼﾞｮｲﾅｰ|ジョイナー|キーボックス|暗証番号|鍵)/.test(line.text)) {
      const cleaned = line.text.replace(/(鍵情報|入館方法)[：:\s]*/g, '').trim();
      if (cleaned.length >= 3 && cleaned.length <= 60) {
        keyInfo = cleaned;
        break;
      }
    }
  }

  // 5. 施工明細行の抽出
  const workItems = [];
  let rowIdx = 1;

  for (const line of fullTextLines) {
    if (/(クロス|壁紙|貼替|アクセント|クリーニング|清掃|美装|エアコン|CF|クッションフロア|巾木|フロア|網戸|補修|洗浄)/.test(line.text)) {
      // 見出し行を除外
      if (/(品名|施工内容|単価|小計|消費税|合計金額)/.test(line.text) && !/(クロス|クリーニング|エアコン)/.test(line.items[0]?.text || '')) {
        continue;
      }

      const grp = line.items;
      let descParts = [];
      let qty = 1.0;
      let unit = '式';
      let amount = 0;

      for (const it of grp) {
        if (/^[0-9]+(\.[0-9]+)?$/.test(it.text) && it.x > 180) {
          qty = parseFloat(it.text);
        } else if (['㎡', '式', 'm', 'ｍ', 'ヶ所', '箇所', '台', '枚'].includes(it.text)) {
          unit = it.text;
        } else if (/^¥?[0-9,]+円?$/.test(it.text) && (it.text.includes('¥') || it.text.includes(','))) {
          const val = parseInt(it.text.replace(/[^0-9]/g, ''), 10) || 0;
          if (val >= 500) amount = val;
        } else if (!/^\d{1,2}$/.test(it.text) || it.x > 80) {
          // 行番号以外を品名パーツとして収集
          descParts.push(it.text);
        }
      }

      const desc = (grp[0] && grp[0].text.length > 3 ? grp[0].text : descParts.join(' ')).trim();
      if (!desc) continue;

      let category = 'cloth';
      if (/(クリーニング|清掃|美装|エアコン|洗浄)/.test(desc)) {
        category = 'cleaning';
      }

      const itemId = resolveWorkItemId(desc, category);

      workItems.push({
        id: 'wi_' + Date.now().toString(36) + '_' + (rowIdx++),
        itemId: itemId,
        itemName: desc,
        category: category,
        contractorId: '', // デフォルト未選択
        assignedContractorId: '',
        quantity: qty,
        unit: unit,
        amount: amount,
        workStartDate: defaultTodayYMD || dueDate,
        workEndDate: dueDate || defaultTodayYMD,
        notes: ''
      });
    }
  }

  // 6. 指定材料・品番の抽出
  const materialsFound = new Set();
  const matMatches = allText.matchAll(/\b(SP[-]?\d{3,4}|RE[-]?\d{4}|FE[-]?\d{4}|LB[-]?\d{4}|SLP[-]?\d{3,4})\b/gi);
  for (const m of matMatches) {
    materialsFound.add(m[1].toUpperCase());
  }
  const materials = materialsFound.size > 0 ? 'サンゲツ他 ' + Array.from(materialsFound).join('、') : '指定なし';

  // 7. 金額サマリー
  const subtotal = workItems.reduce((sum, it) => sum + (it.amount || 0), 0);
  const tax = Math.floor(subtotal * 0.1);
  const total = subtotal + tax;

  return {
    fileName,
    name: name || fileName.replace(/\.pdf$/i, ''),
    address: address || '現地確認（PDF参照）',
    startDate: defaultTodayYMD,
    dueDate: dueDate,
    keyInfo: keyInfo,
    materials: materials,
    client: 'LINE自動受信',
    clientAmount: total,
    pdfSubtotal: subtotal,
    pdfTotal: total,
    workItems: workItems,
    parsedTextLength: allText.length
  };
}

module.exports = {
  parseOrderPdfBuffer
};
