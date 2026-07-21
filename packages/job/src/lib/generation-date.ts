export type GenerationDateParts = {
  year: string;
  month: string;
  day: string;
};

export function getJstDateParts(date = new Date()): GenerationDateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
  };
}

export function parseBusinessDate(businessDate: string): GenerationDateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(businessDate);
  if (!match) {
    throw new Error(`オーダーリスト業務日の形式が不正です: ${businessDate}`);
  }

  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() + 1 !== Number(month)
    || parsed.getUTCDate() !== Number(day)
  ) {
    throw new Error(`オーダーリスト業務日が不正です: ${businessDate}`);
  }

  return { year, month, day };
}

export async function resolveGenerationDisplayDate(params: {
  orderListImportId: string | null;
  loadBusinessDate: (importId: string) => Promise<string | null>;
  now?: Date;
}): Promise<GenerationDateParts> {
  if (!params.orderListImportId) {
    return getJstDateParts(params.now);
  }

  const businessDate = await params.loadBusinessDate(params.orderListImportId);
  if (!businessDate) {
    throw new Error(
      `order_list_import ${params.orderListImportId} の業務日を取得できません`,
    );
  }
  return parseBusinessDate(businessDate);
}

export function formatGenerationDate(parts: GenerationDateParts): string {
  return `${parts.month}/${parts.day}`;
}
