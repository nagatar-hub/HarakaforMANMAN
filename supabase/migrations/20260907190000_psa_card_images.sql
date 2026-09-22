create table if not exists public.psa_card_images (
  card_id text primary key references public.cards(card_id) on delete cascade,
  object_path text not null unique,
  source_image_url text not null,
  overlay_version text not null,
  generated_at timestamptz not null default now()
);

alter table public.psa_card_images enable row level security;
