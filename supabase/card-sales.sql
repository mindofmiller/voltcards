create table public.card_sales (
 line_id text primary key,user_id uuid not null references auth.users(id),order_id text not null,item_id text not null,psa_cert text,title text not null,sold_at timestamptz,currency text not null default 'USD',quantity integer not null default 1,sale_price numeric(12,2),buyer_shipping numeric(12,2),buyer_tax numeric(12,2),transaction_fee numeric(12,2),ad_fee numeric(12,2),postage_cost numeric(12,2),net_order_earnings numeric(12,2),purchase_transaction_id bigint references public.card_transactions(id),estimated_purchase_cost numeric(12,2),estimated_grading_cost numeric(12,2),estimated_handling_cost numeric(12,2),financial_verified_at timestamptz,source text not null default 'ebay',notes text,updated_at timestamptz not null default now());
alter table public.card_sales enable row level security;
create policy card_sales_owner on public.card_sales for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
grant select,insert,update,delete on public.card_sales to authenticated;
grant all on public.card_sales to service_role;
create index card_sales_owner_date on public.card_sales(user_id,sold_at);

