/**
 * テンプレート画像の座標測定スクリプト
 *
 * 使い方:
 *   npx tsx src/scripts/measure-template.ts <fileId>
 *
 * Google Drive からテンプレート画像をダウンロードし、
 * 黄色バー（R>200, G>200, B<50）のY座標を検出して LayoutConfig の雛形を出力する。
 *
 * 実行前に環境変数を設定してください:
 *   GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 */

import sharp from 'sharp';
import { getAccessToken } from '../lib/auth.js';
import { downloadDriveFile } from '../lib/google-drive.js';

// テンプレートファイルID一覧
const TEMPLATE_IDS: Record<string, string> = {
  'PSA-Pokemon':  '17ge8lvza4QAJFvRnGDwwxnkgG5Oh0uqn',
  'PSA-ONEPIECE': '1CCoIwtWbPU3l9A2Na5gzUzaCrllfn8Mu',
  'PSA-YU-GI-OH': '1BEPSikO6dc6sXocrFQb-ZoPKZCRONGdk',
  'BOX-Pokemon':  '1ZiS1Xci3Dlc5i9SJrYoEEUUwiRuCzjZk',
  'BOX-ONEPIECE': '1RiAdjVUyDhpJyb8YxmZsZdSh6PxxEeHy',
  'BOX-YU-GI-OH': '1uhJt5rFJyZgOX9wMvl4vLAckotKpmC_n',
};

interface YellowBand {
  yMin: number;
  yMax: number;
  yCenter: number;
}

/**
 * 画像から黄色ピクセル帯（価格スロット行）の Y 座標を検出する
 */
async function detectYellowBands(buffer: Buffer, gridRows = 5): Promise<YellowBand[]> {
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  console.log(`  画像サイズ: ${width}×${height} (ch=${channels})`);

  // 各 Y 行の黄色ピクセル数をカウント
  const yellowPerRow = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * channels;
      const r = data[base];
      const g = data[base + 1];
      const b = data[base + 2];
      if (r > 200 && g > 200 && b < 50) count++;
    }
    yellowPerRow[y] = count;
  }

  // 閾値（横幅の 10% 以上が黄色ならバンドとみなす）
  const threshold = width * 0.1;

  // 連続した黄色行をグループ化
  const bands: YellowBand[] = [];
  let inBand = false;
  let bandStart = 0;

  for (let y = 0; y < height; y++) {
    if (!inBand && yellowPerRow[y] >= threshold) {
      inBand = true;
      bandStart = y;
    } else if (inBand && yellowPerRow[y] < threshold) {
      inBand = false;
      const yMin = bandStart;
      const yMax = y - 1;
      const yCenter = Math.round((yMin + yMax) / 2);
      bands.push({ yMin, yMax, yCenter });
    }
  }
  if (inBand) {
    const yMax = height - 1;
    bands.push({ yMin: bandStart, yMax, yCenter: Math.round((bandStart + yMax) / 2) });
  }

  return bands;
}

/**
 * 非黄色領域（カードスロット）の Y 座標を推定する
 */
function estimateCardSlotYPositions(
  bands: YellowBand[],
  imageHeight: number,
  gridRows: number,
): number[] {
  if (bands.length < gridRows) {
    // バンドが不足する場合は等分割で推定
    const step = imageHeight / (gridRows + 1);
    return Array.from({ length: gridRows }, (_, i) => Math.round(step * (i + 1)));
  }

  // バンド間の中心を取る
  return bands.slice(0, gridRows).map(b => b.yCenter - 60);
}

async function measureTemplate(name: string, fileId: string, accessToken: string) {
  console.log(`\n=== ${name} (${fileId}) ===`);

  let buffer: Buffer;
  try {
    buffer = await downloadDriveFile(accessToken, fileId);
    console.log(`  ダウンロード完了: ${buffer.length} bytes`);
  } catch (e) {
    console.error(`  ダウンロード失敗:`, e instanceof Error ? e.message : e);
    return;
  }

  const meta = await sharp(buffer).metadata();
  const { width = 1240, height = 1760 } = meta;
  console.log(`  メタ: ${width}×${height}`);

  const bands = await detectYellowBands(buffer);
  console.log(`  黄色バンド数: ${bands.length}`);
  bands.forEach((b, i) => {
    console.log(`    Band ${i + 1}: y=${b.yMin}〜${b.yMax} (center=${b.yCenter})`);
  });

  const GRID_ROWS = 5;
  const GRID_COLS = 6;
  const colWidth = Math.floor(width / GRID_COLS);
  const cardWidth = Math.round(colWidth * 0.85);
  const startX = Math.round((colWidth - cardWidth) / 2);

  // price バンドの Y をそのまま使用
  const priceHighYs = bands.slice(0, GRID_ROWS).map(b => b.yCenter);

  // card Y = priceHighY から上方向 (cardHeight 分)
  const cardHeight = Math.round(colWidth * 1.4);
  const cardYs = priceHighYs.map(py => py - cardHeight - 10);

  // BOX 判定: バンドが行ごとに 2 本ある（価格High と Low）
  const isBox = bands.length >= GRID_ROWS * 2;
  const priceLowYs = isBox
    ? bands.slice(GRID_ROWS, GRID_ROWS * 2).map(b => b.yCenter)
    : priceHighYs.map(py => py + 30);

  const rows = Array.from({ length: GRID_ROWS }, (_, i) => ({
    cardY: cardYs[i] ?? 0,
    priceHighY: priceHighYs[i] ?? 0,
    priceLowY: priceLowYs[i] ?? 0,
  }));

  const layoutConfig = {
    startX,
    priceStartX: startX,
    colWidth,
    cardWidth,
    cardHeight,
    isSmallCard: false,
    rows,
    priceBoxWidth: cardWidth,
    priceBoxHeight: 40,
    dateX: 50,
    dateY: 30,
  };

  console.log(`\n  LayoutConfig (JSON):`);
  console.log(JSON.stringify(layoutConfig, null, 2));
}

async function main() {
  const targetName = process.argv[2];

  console.log('Access token 取得中...');
  const accessToken = await getAccessToken();

  if (targetName && TEMPLATE_IDS[targetName]) {
    await measureTemplate(targetName, TEMPLATE_IDS[targetName], accessToken);
  } else {
    // 全テンプレートを測定
    for (const [name, fileId] of Object.entries(TEMPLATE_IDS)) {
      await measureTemplate(name, fileId, accessToken);
    }
  }
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
