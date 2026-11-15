alter table public.worker_payoffs add column from_account text not null default 'Unspecified source', add column paid_by text not null default 'N/A';
