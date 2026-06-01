/**
 * レイアウトテンプレート画像から価格ボックス（黄色の矩形）を
 * 検出し、layout_config 座標を算出するライブラリ。
 *
 * MANMAN テンプレは黄色の単一価格ボックスなので、黒枠ではなく黄色の
 * 塗り部分を検出する。黒文字やフッター文言を価格枠として誤検出しないため。
 */

import sharp from 'sharp';
import type { LayoutConfig, RowConfig } from '@haraka/shared';

// ---------------------------------------------------------------------------
// 新規レイアウトでのカード寸法推定
// ---------------------------------------------------------------------------
// カードを価格ボックスの幅いっぱいに広げる（少枠レイアウトでカードを大きく見せるため）。
// 高さは TCG カード標準比率（63:88 ≈ 1.397）に従う。
export const CARD_ASPECT_W_OVER_PRICE = 1.0;
export const CARD_ASPECT_H_OVER_W = 88 / 63;
export const DATE_X_DEFAULT = 900;
export const DATE_Y_DEFAULT = 1650;
export const RARITY_ICON_OFFSET_X = 5;
export const RARITY_ICON_OFFSET_Y = -10;
export const RARITY_ICON_WIDTH = 60;
export const RARITY_ICON_HEIGHT = 60;

// 黄色価格枠の色判定。アンチエイリアスを拾うため少し広めに取る。
const YELLOW_R_MIN = 170;
const YELLOW_G_MIN = 160;
const YELLOW_B_MAX = 140;

// 矩形候補のフィルタ
const MIN_BOX_WIDTH = 60;
const MIN_BOX_HEIGHT = 20;
// 1 枚テンプレは価格ボックスが ~658x317 と大きい。画像幅 1240 の半分強を許容。
const MAX_BOX_WIDTH = 900;
const MAX_BOX_HEIGHT = 400;
const MIN_FILL_RATIO = 0.55;
const MAX_FILL_RATIO = 1.00;
const MIN_ASPECT_RATIO = 1.2; // width / height の下限（landscape 矩形）
const ROW_Y_TOLERANCE = 25;   // 同一行とみなす Y 差（px）

// 寸法クラスタリング（タイトル/フッター等の誤検出を弾く）
const CLUSTER_WIDTH_TOLERANCE = 10;  // 同一サイズとみなす幅の差（px）
const CLUSTER_HEIGHT_TOLERANCE = 6;  // 同一サイズとみなす高さの差（px）

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface DetectedBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  pixels: number;
}

export interface DetectedLayout {
  imgWidth: number;
  imgHeight: number;
  boxes: DetectedBox[];             // 左→右、上→下 順にソート済み
  rows: DetectedBox[][];            // 行にグルーピング
  gridCols: number;
  gridRows: number;
  totalSlots: number;
  layoutConfig: LayoutConfig;
}

// ---------------------------------------------------------------------------
// 黄色価格枠の検出
// ---------------------------------------------------------------------------

/**
 * PNG Buffer からレイアウトを検出
 */
export async function detectLayoutFromBuffer(
  buffer: Buffer,
): Promise<DetectedLayout> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pxCount = width * height;

  // 黄色画素マスク
  const yellow = new Uint8Array(pxCount);
  for (let i = 0; i < pxCount; i++) {
    const r = data[i * channels];
    const g = data[i * channels + 1];
    const b = data[i * channels + 2];
    const a = data[i * channels + 3];
    if (a < 128) continue; // 透明部分は無視
    if (r >= YELLOW_R_MIN && g >= YELLOW_G_MIN && b <= YELLOW_B_MAX) {
      yellow[i] = 1;
    }
  }

  // 連結成分ラベリング（BFS・4 近傍・ヒープ型キュー）
  const labels = new Int32Array(pxCount);
  const queue = new Int32Array(pxCount);
  const boxes: DetectedBox[] = [];
  let nextLabel = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!yellow[idx] || labels[idx] !== 0) continue;

      nextLabel++;
      let qHead = 0, qTail = 0;
      queue[qTail++] = idx;
      labels[idx] = nextLabel;

      let minX = x, minY = y, maxX = x, maxY = y;
      let pixels = 0;

      while (qHead < qTail) {
        const cur = queue[qHead++];
        pixels++;
        const cy = (cur / width) | 0;
        const cx = cur - cy * width;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 4 近傍
        if (cx > 0) {
          const n = cur - 1;
          if (yellow[n] && labels[n] === 0) { labels[n] = nextLabel; queue[qTail++] = n; }
        }
        if (cx < width - 1) {
          const n = cur + 1;
          if (yellow[n] && labels[n] === 0) { labels[n] = nextLabel; queue[qTail++] = n; }
        }
        if (cy > 0) {
          const n = cur - width;
          if (yellow[n] && labels[n] === 0) { labels[n] = nextLabel; queue[qTail++] = n; }
        }
        if (cy < height - 1) {
          const n = cur + width;
          if (yellow[n] && labels[n] === 0) { labels[n] = nextLabel; queue[qTail++] = n; }
        }
      }

      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const aspect = w / h;
      const fillRatio = pixels / (w * h);

      if (
        w >= MIN_BOX_WIDTH && w <= MAX_BOX_WIDTH &&
        h >= MIN_BOX_HEIGHT && h <= MAX_BOX_HEIGHT &&
        aspect >= MIN_ASPECT_RATIO &&
        fillRatio >= MIN_FILL_RATIO && fillRatio <= MAX_FILL_RATIO
      ) {
        boxes.push({ minX, minY, maxX, maxY, width: w, height: h, pixels });
      }
    }
  }

  // ---- 寸法クラスタリングで誤検出を除外 ----
  // タイトル「PSA10買取表」やフッター文言等の文字連結成分が矩形候補として残ることがある。
  // 実際のスロットは同一寸法で揃っているので、最頻サイズのクラスタだけを採用する。
  const filteredBoxes = filterByDominantSize(boxes);
  if (filteredBoxes.length === 0) {
    throw new Error('黄色の価格枠が 1 つも検出できませんでした');
  }

  // Y でソート → 行グルーピング
  filteredBoxes.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
  let rows: DetectedBox[][] = [];
  for (const box of filteredBoxes) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].minY - box.minY) <= ROW_Y_TOLERANCE) {
      last.push(box);
    } else {
      rows.push([box]);
    }
  }
  // 各行を X でソート
  for (const row of rows) row.sort((a, b) => a.minX - b.minX);

  if (rows.length === 0) {
    throw new Error('黄色の価格枠が 1 つも検出できませんでした');
  }

  // ---- 欠損スロット補完 ----
  // 上下連結アーティファクトで高さが異常になり除外された枠は、他行と列 X を照合して補完
  rows = fillMissingSlots(rows);

  const gridCols = Math.max(...rows.map(r => r.length));
  const gridRows = rows.length;
  const totalSlots = rows.reduce((sum, r) => sum + r.length, 0);

  // ---- layout_config 算出 ----
  // 行ごとの共通座標（各行の代表矩形の Y を使う）
  const firstBox = rows[0][0];
  const priceBoxWidth = Math.round(firstBox.width);
  const priceBoxHeight = Math.round(firstBox.height); // MANMAN テンプレは黄色の単一価格ボックス

  const cardWidth = Math.round(priceBoxWidth * CARD_ASPECT_W_OVER_PRICE);
  const cardHeight = Math.round(cardWidth * CARD_ASPECT_H_OVER_W);

  // 列ピッチ（colWidth）: 先頭の 2 列の X 差。単列なら width + gap 推定で代用
  const firstRow = rows[0];
  const colWidth = firstRow.length >= 2
    ? firstRow[1].minX - firstRow[0].minX
    : priceBoxWidth + 20;

  // startX / priceStartX
  const priceStartX = firstRow[0].minX;
  const startX = priceStartX + Math.round((priceBoxWidth - cardWidth) / 2);

  // 各行の座標
  const rowConfigs: RowConfig[] = rows.map((row) => {
    const r = row[0];
    const priceHighY = r.minY;
    const priceLowY = r.minY;
    const cardY = priceHighY - cardHeight;
    return { cardY, priceHighY, priceLowY };
  });

  // isSmallCard: 遊戯王向け判定の慣習に倣い、cardWidth が 120 未満なら true
  const isSmallCard = cardWidth < 120;

  const layoutConfig: LayoutConfig = {
    startX,
    priceStartX,
    colWidth,
    cardWidth,
    cardHeight,
    isSmallCard,
    rows: rowConfigs,
    priceBoxWidth,
    priceBoxHeight,
    dateX: DATE_X_DEFAULT,
    dateY: DATE_Y_DEFAULT,
    rarityIconOffsetX: RARITY_ICON_OFFSET_X,
    rarityIconOffsetY: RARITY_ICON_OFFSET_Y,
    rarityIconWidth: RARITY_ICON_WIDTH,
    rarityIconHeight: RARITY_ICON_HEIGHT,
  };

  return {
    imgWidth: width,
    imgHeight: height,
    boxes: filteredBoxes,
    rows,
    gridCols,
    gridRows,
    totalSlots,
    layoutConfig,
  };
}

/**
 * 行ごとに検出数にばらつきがある場合、他行の列 X を参考に欠損スロットを補う。
 *
 * ケース：フッター文字等と連結して高さが伸び、高さクラスタから弾かれた枠。
 * 他行で検出された列 X 位置のうち、この行に存在しないものを「欠損」とみなし、
 * 同じ寸法・この行の Y で補完ボックスを追加する。
 */
function fillMissingSlots(rows: DetectedBox[][]): DetectedBox[][] {
  if (rows.length <= 1) return rows;

  // 全行の列 X を集める（マージ許容 20px）
  const COLUMN_MERGE_TOL = 20;
  const allX = rows.flatMap(r => r.map(b => b.minX)).sort((a, b) => a - b);
  const columnXs: number[] = [];
  const columnCounts: number[] = [];
  for (const x of allX) {
    const lastIdx = columnXs.length - 1;
    if (lastIdx >= 0 && x - columnXs[lastIdx] <= COLUMN_MERGE_TOL) {
      // マージ（平均）
      const n = columnCounts[lastIdx];
      columnXs[lastIdx] = Math.round((columnXs[lastIdx] * n + x) / (n + 1));
      columnCounts[lastIdx] = n + 1;
    } else {
      columnXs.push(x);
      columnCounts.push(1);
    }
  }

  // 2 行以上で観測された列のみ「正当」とみなす
  const validColumnXs = columnXs.filter((_, i) => columnCounts[i] >= 2);
  if (validColumnXs.length === 0) return rows;

  // 代表寸法
  const allBoxes = rows.flat();
  const medianW = median(allBoxes.map(b => b.width));
  const medianH = median(allBoxes.map(b => b.height));

  // 各行について、欠けている列 X を補完
  return rows.map(row => {
    const presentCols = new Set(
      row.map(b => validColumnXs.reduce(
        (best, cx) => Math.abs(cx - b.minX) < Math.abs(best - b.minX) ? cx : best,
        validColumnXs[0],
      )),
    );
    const rowY = Math.round(row.reduce((s, b) => s + b.minY, 0) / row.length);
    const missing = validColumnXs
      .filter(cx => !presentCols.has(cx))
      .map<DetectedBox>(cx => ({
        minX: cx,
        minY: rowY,
        maxX: cx + medianW - 1,
        maxY: rowY + medianH - 1,
        width: medianW,
        height: medianH,
        pixels: 0,
      }));
    return [...row, ...missing].sort((a, b) => a.minX - b.minX);
  });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * 検出した矩形候補を「最も多く出現する寸法クラスタ」に絞り込む。
 *
 * 背景のタイトル帯や注意書き文言は寸法が他と大きく異なるため、
 * 同一寸法で多数派を占める実スロットだけを残す。
 *
 * アルゴリズム:
 *   1. 高さで貪欲クラスタリング（価格ボックスの高さは全スロットで一定）
 *   2. 最頻高さクラスタ内で、幅のメディアンを基準にスロットを絞り込む
 *   3. メディアン幅と合致する "clean" ボックスから列 X を抽出
 *   4. 幅が異常なボックスは、左辺 / 右辺のどちらが列 X に近いかで snap
 *      （連結アーティファクトが左右どちらに伸びたかを自動判別）
 */
function filterByDominantSize(boxes: DetectedBox[]): DetectedBox[] {
  if (boxes.length === 0) return [];

  // Step 1: 高さでクラスタリング
  type HCluster = { h: number; members: DetectedBox[] };
  const hClusters: HCluster[] = [];
  for (const box of boxes) {
    const hit = hClusters.find(c => Math.abs(c.h - box.height) <= CLUSTER_HEIGHT_TOLERANCE);
    if (hit) {
      hit.members.push(box);
      hit.h = Math.round(hit.members.reduce((s, m) => s + m.height, 0) / hit.members.length);
    } else {
      hClusters.push({ h: box.height, members: [box] });
    }
  }
  hClusters.sort((a, b) => b.members.length - a.members.length);
  const dominantH = hClusters[0];

  // Step 2: 幅メディアン
  const sortedWidths = [...dominantH.members].map(m => m.width).sort((a, b) => a - b);
  const medianW = sortedWidths[Math.floor(sortedWidths.length / 2)];

  // Step 3: 高さ／幅の許容値で絞り込み
  const widthTol = Math.max(CLUSTER_WIDTH_TOLERANCE * 3, Math.round(medianW * 0.25));
  const heightTol = CLUSTER_HEIGHT_TOLERANCE * 2;
  const candidates = boxes.filter(b =>
    Math.abs(b.height - dominantH.h) <= heightTol &&
    Math.abs(b.width - medianW) <= widthTol,
  );

  // Step 4: clean（幅メディアン近傍）と anomalous に分離
  const clean = candidates.filter(b => Math.abs(b.width - medianW) <= CLUSTER_WIDTH_TOLERANCE);
  const anomalous = candidates.filter(b => Math.abs(b.width - medianW) > CLUSTER_WIDTH_TOLERANCE);

  if (anomalous.length === 0) return clean;

  // clean ボックスから列 X を抽出（近いもの同士をマージ）
  const COLUMN_MERGE_TOL = 20;
  const columnXs: number[] = [];
  for (const x of clean.map(b => b.minX).sort((a, b) => a - b)) {
    if (columnXs.length === 0 || x - columnXs[columnXs.length - 1] > COLUMN_MERGE_TOL) {
      columnXs.push(x);
    }
  }

  // clean が空なら snap 不能。anomalous を中心基準で正規化して返す。
  if (columnXs.length === 0) {
    return anomalous.map(b => {
      const centerX = b.minX + b.width / 2;
      const newMinX = Math.round(centerX - medianW / 2);
      return { ...b, minX: newMinX, maxX: newMinX + medianW - 1, width: medianW };
    });
  }

  // Step 5: anomalous は、左辺 / 右辺のどちらかが列 X に一致する方を採用
  const snapped = anomalous.map(b => {
    const rightTrimX = b.minX;                 // 右側が伸びた前提（左辺そのまま）
    const leftTrimX = b.maxX - medianW + 1;    // 左側が伸びた前提（右辺基準で medianW 分戻す）
    const closest = (x: number) => columnXs.reduce(
      (best, cx) => Math.abs(cx - x) < Math.abs(best - x) ? cx : best,
      columnXs[0],
    );
    const leftBest = closest(leftTrimX);
    const rightBest = closest(rightTrimX);
    const leftDist = Math.abs(leftBest - leftTrimX);
    const rightDist = Math.abs(rightBest - rightTrimX);
    const targetX = leftDist <= rightDist ? leftBest : rightBest;
    return { ...b, minX: targetX, maxX: targetX + medianW - 1, width: medianW };
  });

  return [...clean, ...snapped];
}

// ---------------------------------------------------------------------------
// 可視化 PNG 生成
// ---------------------------------------------------------------------------

/**
 * 検出結果を元画像に重ねて描画した PNG を返す。
 * - 赤枠: 検出した価格ボックス（黄色矩形）
 * - 青枠: 推定したカード配置エリア
 * - 黄円: 検出の中心マーカー
 */
export async function renderDetectionDebugImage(
  originalBuffer: Buffer,
  detected: DetectedLayout,
): Promise<Buffer> {
  const { imgWidth, imgHeight, layoutConfig, gridCols, gridRows, totalSlots, rows } = detected;

  // 全オーバーレイを 1 枚の SVG にまとめる（sharp の stroke クリップ回避）
  const svgParts: string[] = [];

  // 価格ボックス（赤枠・半透明塗り）
  for (const row of rows) {
    for (const box of row) {
      svgParts.push(
        `<rect x="${box.minX}" y="${box.minY}" width="${box.width}" height="${box.height}" ` +
        `fill="#ff0033" fill-opacity="0.18" stroke="#ff0033" stroke-width="4"/>`,
      );
      // 中心マーカー
      const cx = box.minX + box.width / 2;
      const cy = box.minY + box.height / 2;
      svgParts.push(`<circle cx="${cx}" cy="${cy}" r="4" fill="#ffcc00"/>`);
    }
  }

  // カードエリア（青枠）
  for (let r = 0; r < layoutConfig.rows.length; r++) {
    const rowConfig = layoutConfig.rows[r];
    const colsInRow = rows[r]?.length ?? 0;
    for (let c = 0; c < colsInRow; c++) {
      const priceBox = rows[r][c];
      const x = priceBox.minX + Math.round((priceBox.width - layoutConfig.cardWidth) / 2);
      svgParts.push(
        `<rect x="${x}" y="${rowConfig.cardY}" width="${layoutConfig.cardWidth}" height="${layoutConfig.cardHeight}" ` +
        `fill="none" stroke="#3399ff" stroke-width="4" stroke-dasharray="10,6"/>`,
      );
    }
  }

  // 情報ラベル
  const info = `${gridCols}x${gridRows} = ${totalSlots} slots | cardW=${layoutConfig.cardWidth} cardH=${layoutConfig.cardHeight} | priceBoxW=${layoutConfig.priceBoxWidth}`;
  svgParts.push(
    `<rect x="0" y="0" width="${imgWidth}" height="60" fill="black" fill-opacity="0.75"/>` +
    `<text x="20" y="42" font-family="Arial, sans-serif" font-size="28" fill="white" font-weight="bold">${escapeXml(info)}</text>`,
  );

  const fullSvg =
    `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">` +
    svgParts.join('') +
    `</svg>`;

  return await sharp(originalBuffer)
    .composite([{ input: Buffer.from(fullSvg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
