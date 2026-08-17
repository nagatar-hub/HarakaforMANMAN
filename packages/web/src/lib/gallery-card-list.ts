export type GalleryCardListItem = {
  card_name: string;
  list_no: string | null;
  price_high: number | null;
};

export function formatGalleryCardList(cards: GalleryCardListItem[]): string {
  return cards
    .map((card) => `${card.card_name}${card.list_no ? `(${card.list_no})` : ''} ￥${card.price_high?.toLocaleString('ja-JP') ?? '-'}`)
    .join('\n');
}
