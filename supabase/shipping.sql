-- Seller shipments are separate from inbound card_transactions.
create table public.shipping_orders (
  id text primary key,
  user_id uuid not null references auth.users(id),
  account text not null check (account = 'voltlabsllc'),
  created_at timestamptz not null,
  paid_at timestamptz,
  canceled boolean not null default false,
  items jsonb not null default '[]',
  buyer text,
  destination jsonb not null default '{}',
  service text,
  total numeric,
  currency text,
  tracking_number text,
  carrier text,
  ebay_shipped_at timestamptz,
  handed_off_at timestamptz,
  delivery_status text,
  delivery_checked_at timestamptz,
  tracker_id text,
  updated_at timestamptz not null default now()
);
alter table public.shipping_orders enable row level security;
revoke all on public.shipping_orders from anon, authenticated;
grant select on public.shipping_orders to authenticated;
create policy shipping_owner_read on public.shipping_orders for select to authenticated
using ((select auth.uid()) = user_id);

create table public.shipping_labels (
  order_id text primary key references public.shipping_orders(id),
  pdf_base64 text not null,
  emailed_at timestamptz,
  email_id text,
  created_at timestamptz not null default now()
);
alter table public.shipping_labels enable row level security;
revoke all on public.shipping_labels from anon, authenticated;

create table public.shipping_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  result jsonb
);
alter table public.shipping_runs enable row level security;
revoke all on public.shipping_runs from anon, authenticated;
grant all on public.shipping_orders, public.shipping_labels, public.shipping_runs to service_role;
grant usage, select on sequence public.shipping_runs_id_seq to service_role;
