-- Service-only, atomic receipt and inventory save. Photos themselves are not stored.
create table if not exists public.photo_checkin_receipts (
  batch_key text primary key, user_id uuid not null, worker text not null,
  photo_hashes text[] not null, receipt jsonb not null, created_at timestamptz not null default now()
);
alter table public.photo_checkin_receipts enable row level security;
revoke all on public.photo_checkin_receipts from anon, authenticated;
grant all on public.photo_checkin_receipts to service_role;
create or replace function public.save_photo_checkin(p_user uuid,p_worker text,p_key text,p_hashes text[],p_plan jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare saved jsonb; entry jsonb; row_id bigint; ids jsonb := '[]'; added integer := 0; matched integer := 0;
begin
  if p_worker not in ('steve','connor') or p_key !~ '^[a-f0-9]{64}$' then raise exception 'Invalid batch'; end if;
  -- Serialize this owner's uploads, including overlapping photo sets.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
  select receipt into saved from photo_checkin_receipts where batch_key=p_key and user_id=p_user;
  if found then return saved || '{"replayed":true}'::jsonb; end if;
  if exists(select 1 from photo_checkin_receipts where user_id=p_user and photo_hashes && p_hashes) then
    raise exception 'Some photos were already checked in. Upload only the new photos together.';
  end if;
  for entry in select value from jsonb_array_elements(p_plan->'items') loop
    if entry->>'id' is not null then
      update card_transactions set received_at=now() where id=(entry->>'id')::bigint
        and user_id=p_user and type='buy' and not canceled and not flagged_defective and received_at is null
        and coalesce(quantity,1)=1
        and (case when p_worker='connor' then coalesce(ship_to_name,'') ~* 'connor'
          else coalesce(ship_to_postal,'') like '61761%' and coalesce(ship_to_name,'') !~* 'connor' end)
        returning id into row_id;
      if not found then raise exception 'A purchase changed while reading photos. Retry this batch.'; end if;
      matched := matched+1;
    else
      insert into card_transactions(user_id,type,item_title,card_number,game,quantity,price,confidence,email_id,received_at,ship_to_name,ship_to_city,ship_to_state,ship_to_postal)
      values(p_user,'buy',entry->>'title',entry->>'number','Pokemon',1,null,'photo',
        'photo-checkin:'||p_key||':'||(matched+added)::text,now(),
        case when p_worker='steve' then 'Brett Miller' else 'Connor' end,
        case when p_worker='steve' then 'Normal' end,case when p_worker='steve' then 'IL' end,
        case when p_worker='steve' then '61761-3230' end) returning id into row_id;
      added := added+1;
    end if;
    ids := ids || jsonb_build_array(row_id);
  end loop;
  saved := p_plan || jsonb_build_object('ok',true,'matched',matched,'inventory_added',added,'committed',matched+added,'ids',ids,'worker',p_worker);
  insert into photo_checkin_receipts(batch_key,user_id,worker,photo_hashes,receipt) values(p_key,p_user,p_worker,p_hashes,saved);
  return saved;
end $$;
revoke all on function public.save_photo_checkin(uuid,text,text,text[],jsonb) from public,anon,authenticated;
grant execute on function public.save_photo_checkin(uuid,text,text,text[],jsonb) to service_role;
