/**
 * 画像合成エンジン
 *
 * テンプレート画像の上に:
 * 1. カード画像を配置
 * 2. 価格テキスト（SVG）をオーバーレイ
 * 3. レアリティアイコンを重ね合わせ
 * 4. 日付スタンプを追加
 *
 * sharp ライブラリを使用して高速に合成する
 */

import sharp, { type OverlayOptions } from 'sharp';
import type { LayoutConfig, PreparedCardRow, AssetProfileRow } from '@haraka/shared';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface ComposePageParams {
  /** テンプレート画像の Buffer */
  templateBuffer: Buffer;
  /** カード裏面画像の Buffer */
  cardBackBuffer: Buffer;
  /** このページのカード配列（スロット順） */
  cards: PreparedCardRow[];
  /** レイアウト設定 */
  layout: LayoutConfig;
  /** アセットプロファイル */
  assetProfile: AssetProfileRow;
  /** レアリティアイコン: rarity_icon_url → Buffer */
  rarityIconBuffers?: Map<string, Buffer>;
  /** カード画像: card.id → Buffer */
  cardImageBuffers: Map<string, Buffer>;
  /** 日付文字列 (例: "2026/03/11") */
  dateText: string;
  /** true の場合 price_low（青）をスキップ（BOXページ用） */
  skipPriceLow?: boolean;
  /** レイアウト微調整: 全行に固定オフセット */
  layoutAdjust?: { cardYDelta: number; priceYDelta: number };
  /** 行別の価格Y微調整: rowIndex → { priceHighYDelta, priceLowYDelta } */
  rowPriceAdjust?: Record<number, { priceHighYDelta?: number; priceLowYDelta?: number }>;
  /** 行別のカードY微調整: rowIndex → delta px */
  rowCardAdjust?: Record<number, number>;
  /** 空きスロットをカード裏面で埋める枚数 */
  totalSlots?: number;
}

// ---------------------------------------------------------------------------
// SVG テキスト生成
// ---------------------------------------------------------------------------

/** SVG で使用するゴシック系フォントフォールバック（SVG属性内で使うため &quot; は不可） */
const GOTHIC_FONT = 'Noto Sans CJK JP, Noto Sans JP, Meiryo, Yu Gothic, Arial, sans-serif';

/**
 * 価格テキスト用 SVG Buffer を生成
 */
function createPriceTextSvg(params: {
  text: string;
  width: number;
  height: number;
  fontFamily: string;
  color: string;
  fontSize: number;
}): Buffer {
  const { text, width, height, color, fontSize } = params;
  const y = Math.round(height / 2 + fontSize * 0.35);
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="${width / 2}" y="${y}" font-family="${GOTHIC_FONT}" font-size="${fontSize}" font-weight="bold" fill="${color}" text-anchor="middle">${escapeXml(text)}</text></svg>`;
  return Buffer.from(svg);
}

/**
 * 日付テキスト用 SVG Buffer を生成（白文字 + 黒縁）
 */
function createDateTextSvg(params: {
  text: string;
  fontFamily: string;
}): Buffer {
  const { text } = params;
  const width = 400;
  const height = 100;
  const fontSize = 72;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="${width}" y="${fontSize}" font-family="${GOTHIC_FONT}" font-size="${fontSize}" font-weight="bold" fill="white" stroke="black" stroke-width="6" paint-order="stroke fill" text-anchor="end">${escapeXml(text)}</text></svg>`;
  return Buffer.from(svg);
}

/**
 * XML エスケープ
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// 価格フォーマット
// ---------------------------------------------------------------------------

/**
 * 数値を価格文字列に変換
 * format: "¥{price}" → "¥10,000"
 */
function formatPrice(price: number, format: string): string {
  const formatted = price.toLocaleString('ja-JP');
  return format.replace('{price}', formatted);
}

// ---------------------------------------------------------------------------
// メイン合成関数
// ---------------------------------------------------------------------------

/**
 * 1 ページ分の買取表画像を生成
 */
export async function composePage(params: ComposePageParams): Promise<Buffer> {
  const {
    templateBuffer,
    cardBackBuffer,
    cards,
    layout,
    assetProfile,
    rarityIconBuffers,
    cardImageBuffers,
    dateText,
    skipPriceLow,
    layoutAdjust,
    rowPriceAdjust,
    rowCardAdjust,
    totalSlots,
  } = params;

  const cols = assetProfile.grid_cols;
  const composites: OverlayOptions[] = [];

  // カード裏面をリサイズしておく
  const cardBackResized = await sharp(cardBackBuffer)
    .resize(layout.cardWidth, layout.cardHeight, { fit: 'fill' })
    .png()
    .toBuffer();

  // 各カードスロットを処理
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const col = i % cols;
    const rowIndex = Math.floor(i / cols);

    // 行が layout.rows を超えたらスキップ
    if (rowIndex >= layout.rows.length) break;

    const rowConfig = layout.rows[rowIndex];
    const adjustCardY = layoutAdjust?.cardYDelta ?? 0;
    const adjustPriceY = layoutAdjust?.priceYDelta ?? 0;
    const x = layout.startX + col * layout.colWidth;

    // ---- カード画像 ----
    let cardBuffer: Buffer;
    const imageBuffer = cardImageBuffers.get(card.id);

    if (imageBuffer) {
      // カード画像が取得できた
      try {
        cardBuffer = await sharp(imageBuffer)
          .resize(layout.cardWidth, layout.cardHeight, { fit: 'cover' })
          .png()
          .toBuffer();
      } catch {
        // リサイズ失敗時はカード裏面を使用
        cardBuffer = cardBackResized;
      }
    } else {
      // 画像なし → カード裏面
      cardBuffer = cardBackResized;
    }

    const rowCardDelta = rowCardAdjust?.[rowIndex] ?? 0;
    composites.push({
      input: cardBuffer,
      left: x,
      top: rowConfig.cardY + adjustCardY + rowCardDelta,
    });

    // ---- レアリティアイコン ----
    if (
      card.rarity_icon_url &&
      rarityIconBuffers?.has(card.rarity_icon_url) &&
      layout.rarityIconWidth &&
      layout.rarityIconHeight
    ) {
      try {
        const iconBuffer = await sharp(rarityIconBuffers.get(card.rarity_icon_url)!)
          .resize(layout.rarityIconWidth, layout.rarityIconHeight, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer();

        composites.push({
          input: iconBuffer,
          left: x + layout.cardWidth - layout.rarityIconWidth + (layout.rarityIconOffsetX ?? 0),
          top: rowConfig.cardY + adjustCardY + rowCardDelta + (layout.rarityIconOffsetY ?? 0),
        });
      } catch {
        // アイコンリサイズ失敗は無視
      }
    }

    // ---- 価格テキスト ----
    const priceX = layout.priceStartX + col * layout.colWidth;
    const fontSize = layout.isSmallCard ? 14 : 16;

    if (card.price_high && card.price_high > 0) {
      // price_high（赤）
      const priceHighText = formatPrice(card.price_high, assetProfile.price_format);
      const priceHighSvg = createPriceTextSvg({
        text: priceHighText,
        width: layout.priceBoxWidth,
        height: layout.priceBoxHeight,
        fontFamily: assetProfile.font_family,
        color: '#CC0000',
        fontSize,
      });
      const rowAdj = rowPriceAdjust?.[rowIndex];
      composites.push({
        input: priceHighSvg,
        left: priceX,
        top: Math.round(rowConfig.priceHighY + adjustPriceY + (rowAdj?.priceHighYDelta ?? 0)),
      });

      // price_low（青） — skipPriceLow が true の場合はスキップ
      if (!skipPriceLow && card.price_low && card.price_low > 0) {
        const priceLowText = formatPrice(card.price_low, assetProfile.price_format);
        const priceLowSvg = createPriceTextSvg({
          text: priceLowText,
          width: layout.priceBoxWidth,
          height: layout.priceBoxHeight,
          fontFamily: assetProfile.font_family,
          color: '#0033CC',
          fontSize,
        });
        composites.push({
          input: priceLowSvg,
          left: priceX,
          top: Math.round(rowConfig.priceLowY + adjustPriceY + (rowAdj?.priceLowYDelta ?? 0)),
        });
      }
    }
  }

  // 空きスロットをカード裏面で埋める
  const slotsToFill = totalSlots ?? 0;
  for (let i = cards.length; i < slotsToFill; i++) {
    const col = i % cols;
    const rowIndex = Math.floor(i / cols);
    if (rowIndex >= layout.rows.length) break;

    const rowConfig = layout.rows[rowIndex];
    const adjustCardY = layoutAdjust?.cardYDelta ?? 0;
    const x = layout.startX + col * layout.colWidth;

    const rowCardDelta2 = rowCardAdjust?.[rowIndex] ?? 0;
    composites.push({
      input: cardBackResized,
      left: x,
      top: rowConfig.cardY + adjustCardY + rowCardDelta2,
    });
  }

  // ---- 日付スタンプ ----
  const dateSvg = createDateTextSvg({
    text: dateText,
    fontFamily: assetProfile.font_family,
  });
  // 日付 SVG は text-anchor="end" で右寄せ。dateX を右端基準に配置
  composites.push({
    input: dateSvg,
    left: layout.dateX - 100,
    top: layout.dateY - 20,
  });

  // ---- 合成実行 ----
  const result = await sharp(templateBuffer)
    .composite(composites)
    .png()
    .toBuffer();

  return result;
}
