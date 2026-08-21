import { isBuiltInOrderListExclusion, type Franchise } from '@haraka/shared';

export type OrderListMatchStatus = 'matched' | 'ambiguous' | 'unmatched' | 'excluded' | 'invalid';
export type OrderListMatchMethod = 'existing_mapping' | 'exact_image' | 'exact_identity' | null;

export type MatchableOrderListRow = {
  franchise: Franchise;
  excelProductId: string;
  cardName: string;
  grade: string | null;
  listNo: string | null;
  imageUrl: string | null;
  valid: boolean;
  validationIssues: unknown[];
};

export type DbCardMatchInput = {
  id: string;
  franchise: string;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  image_url: string | null;
  alt_image_url: string | null;
};

export type ExistingProductMapping = {
  id: string;
  franchise: string;
  excel_product_id: string;
  db_card_id: string | null;
  status: string;
};

export type OrderListMatchResult<T extends MatchableOrderListRow = MatchableOrderListRow> = {
  row: T;
  status: OrderListMatchStatus;
  method: OrderListMatchMethod;
  dbCardId: string | null;
  mappingId: string | null;
  candidateDbCardIds: string[];
  note: string | null;
};

type CandidateIndex = Map<string, DbCardMatchInput[]>;

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('ja-JP');
}

function identityKey(
  franchise: string,
  cardName: string,
  grade: string | null | undefined,
  listNo: string | null | undefined,
): string {
  return [
    normalizeText(franchise),
    normalizeText(cardName),
    normalizeText(grade),
    normalizeText(listNo),
  ].join('\u0000');
}

/**
 * URLは完全一致だけを自動照合に使う。署名クエリ等を勝手に落とすと別商品を
 * 同一視し得るため、ホスト名・標準ポート・hash・末尾slashだけを正規化する。
 */
export function normalizeImageUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return null;
  }
}

function addCandidate(index: CandidateIndex, key: string | null, card: DbCardMatchInput): void {
  if (!key) return;
  const current = index.get(key);
  if (current) {
    if (!current.some((entry) => entry.id === card.id)) current.push(card);
  } else {
    index.set(key, [card]);
  }
}

function buildIndexes(dbCards: DbCardMatchInput[]): {
  dbCardById: Map<string, DbCardMatchInput>;
  identity: CandidateIndex;
  image: CandidateIndex;
} {
  const dbCardById = new Map<string, DbCardMatchInput>();
  const identity: CandidateIndex = new Map();
  const image: CandidateIndex = new Map();

  for (const card of dbCards) {
    dbCardById.set(card.id, card);
    addCandidate(
      identity,
      identityKey(card.franchise, card.card_name, card.grade, card.list_no),
      card,
    );
    addCandidate(image, normalizeImageUrl(card.image_url), card);
    addCandidate(image, normalizeImageUrl(card.alt_image_url), card);
  }

  return { dbCardById, identity, image };
}

function mappingKey(franchise: string, excelProductId: string): string {
  return `${normalizeText(franchise)}\u0000${normalizeText(excelProductId)}`;
}

function uniqueScopedCandidates(
  candidates: DbCardMatchInput[] | undefined,
  franchise: string,
  grade?: string | null,
): DbCardMatchInput[] {
  if (!candidates) return [];
  const wanted = normalizeText(franchise);
  return candidates.filter((candidate) =>
    normalizeText(candidate.franchise) === wanted
    && (grade === undefined || normalizeText(candidate.grade) === normalizeText(grade))
  );
}

/**
 * 安全な自動照合だけを実行する。
 *
 * 1. 保存済みのExcel商品ID対応表
 * 2. 同一商材・種別内の完全一致画像URL（候補が1件だけ）
 * 3. 商材 + 商品名 + 種別 + リスト番号の厳密一致（候補が1件だけ）
 *
 * 0件は unmatched、複数件は ambiguous とし、先頭候補を黙って採用しない。
 */
export function matchOrderListRows<T extends MatchableOrderListRow>(
  rows: T[],
  dbCards: DbCardMatchInput[],
  existingMappings: ExistingProductMapping[],
): OrderListMatchResult<T>[] {
  const { dbCardById, identity, image } = buildIndexes(dbCards);
  const mappingByProduct = new Map<string, ExistingProductMapping>();

  const excludedMappingByProduct = new Map<string, ExistingProductMapping>();
  for (const mapping of existingMappings) {
    if (mapping.status === 'disabled') {
      excludedMappingByProduct.set(
        mappingKey(mapping.franchise, mapping.excel_product_id),
        mapping,
      );
      continue;
    }
    if (!mapping.db_card_id) continue;
    mappingByProduct.set(
      mappingKey(mapping.franchise, mapping.excel_product_id),
      mapping,
    );
  }

  return rows.map((row): OrderListMatchResult<T> => {
    if (!row.valid) {
      return {
        row,
        status: 'invalid',
        method: null,
        dbCardId: null,
        mappingId: null,
        candidateDbCardIds: [],
        note: 'Excel行の検証エラーがあります',
      };
    }

    const exclusion = excludedMappingByProduct.get(
      mappingKey(row.franchise, row.excelProductId),
    );
    if (exclusion) {
      return {
        row,
        status: 'excluded',
        method: null,
        dbCardId: null,
        mappingId: exclusion.id,
        candidateDbCardIds: [],
        note: 'このExcel商品IDは買取表に載せない設定です',
      };
    }

    if (isBuiltInOrderListExclusion(row.cardName)) {
      return {
        row,
        status: 'excluded',
        method: null,
        dbCardId: null,
        mappingId: null,
        candidateDbCardIds: [],
        note: 'この商品は買取表に載せない共通設定です',
      };
    }

    const savedMapping = mappingByProduct.get(mappingKey(row.franchise, row.excelProductId));
    if (savedMapping?.db_card_id) {
      const mappedCard = dbCardById.get(savedMapping.db_card_id);
      if (mappedCard && normalizeText(mappedCard.franchise) === normalizeText(row.franchise)) {
        return {
          row,
          status: 'matched',
          method: 'existing_mapping',
          dbCardId: mappedCard.id,
          mappingId: savedMapping.id,
          candidateDbCardIds: [mappedCard.id],
          note: null,
        };
      }
    }

    const imageCandidates = uniqueScopedCandidates(
      image.get(normalizeImageUrl(row.imageUrl) ?? ''),
      row.franchise,
      row.grade,
    );
    if (imageCandidates.length === 1) {
      return {
        row,
        status: 'matched',
        method: 'exact_image',
        dbCardId: imageCandidates[0].id,
        mappingId: null,
        candidateDbCardIds: [imageCandidates[0].id],
        note: null,
      };
    }

    const identityCandidates = uniqueScopedCandidates(
      identity.get(identityKey(row.franchise, row.cardName, row.grade, row.listNo)),
      row.franchise,
    );
    if (identityCandidates.length === 1) {
      return {
        row,
        status: 'matched',
        method: 'exact_identity',
        dbCardId: identityCandidates[0].id,
        mappingId: null,
        candidateDbCardIds: [identityCandidates[0].id],
        note: null,
      };
    }
    if (identityCandidates.length > 1) {
      return {
        row,
        status: 'ambiguous',
        method: null,
        dbCardId: null,
        mappingId: null,
        candidateDbCardIds: identityCandidates.map((card) => card.id),
        note: '商品名・種別・リスト番号が一致するDB商品が複数あります',
      };
    }
    if (imageCandidates.length > 1) {
      return {
        row,
        status: 'ambiguous',
        method: null,
        dbCardId: null,
        mappingId: null,
        candidateDbCardIds: imageCandidates.map((card) => card.id),
        note: '同じ画像URLのDB商品が複数あり、商品情報でも一意に絞れません',
      };
    }

    return {
      row,
      status: 'unmatched',
      method: null,
      dbCardId: null,
      mappingId: null,
      candidateDbCardIds: [],
      note: savedMapping
        ? '保存済み対応先のDB商品が見つからないため再照合が必要です'
        : '対応するDB商品が見つかりません',
    };
  });
}
