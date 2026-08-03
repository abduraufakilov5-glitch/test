-- Учёт долгов клиентов — production schema. Run the whole file in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 200),
  phone text check (phone is null or char_length(phone) <= 80),
  notes text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id uuid not null,
  type text not null check (type in ('DEBT','PAYMENT','ADJUSTMENT')),
  amount numeric(12,2) not null,
  description text check (description is null or char_length(description) <= 2000),
  transaction_date date not null default current_date,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  constraint transactions_client_owner_fk foreign key (client_id, user_id)
    references public.clients(id, user_id) on delete restrict,
  constraint transactions_amount_semantics check (
    (type in ('DEBT','PAYMENT') and amount > 0) or
    (type = 'ADJUSTMENT' and amount <> 0)
  ),
  unique (user_id, idempotency_key)
);

-- Upgrade an earlier project in-place without deleting financial data.
alter table public.transactions add column if not exists idempotency_key uuid;
update public.transactions set idempotency_key = gen_random_uuid() where idempotency_key is null;
alter table public.transactions alter column idempotency_key set not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='clients_id_user_unique') then
    alter table public.clients add constraint clients_id_user_unique unique(id,user_id);
  end if;
end $$;

alter table public.transactions drop constraint if exists transactions_client_id_fkey;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='transactions_client_owner_fk') then
    alter table public.transactions add constraint transactions_client_owner_fk foreign key(client_id,user_id) references public.clients(id,user_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname='transactions_user_idempotency_unique') then
    alter table public.transactions add constraint transactions_user_idempotency_unique unique(user_id,idempotency_key);
  end if;
end $$;

create table if not exists public.migration_status (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  initial_migration_done boolean not null default false,
  migrated_at timestamptz,
  migrated_count integer check (migrated_count is null or migrated_count >= 0),
  migrated_total numeric(12,2) check (migrated_total is null or migrated_total >= 0)
);
alter table public.migration_status add column if not exists migrated_total numeric(12,2);


create table if not exists public.restore_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  backup_id uuid not null,
  restored_at timestamptz not null default now(),
  client_count integer not null check (client_count >= 0),
  transaction_count integer not null check (transaction_count >= 0),
  primary key (user_id, backup_id)
);

create index if not exists idx_clients_user_id on public.clients(user_id);
create index if not exists idx_transactions_user_id on public.transactions(user_id);
create index if not exists idx_transactions_client_id on public.transactions(client_id);
create index if not exists idx_transactions_user_date on public.transactions(user_id, transaction_date desc);

create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_clients_updated_at on public.clients;
create trigger trg_clients_updated_at before update on public.clients for each row execute function public.set_updated_at();

alter table public.clients enable row level security;
alter table public.transactions enable row level security;
alter table public.migration_status enable row level security;
alter table public.restore_history enable row level security;

-- Recreate policies. Financial transaction mutation is intentionally NOT exposed directly.
drop policy if exists clients_select_own on public.clients;
drop policy if exists clients_insert_own on public.clients;
drop policy if exists clients_update_own on public.clients;
drop policy if exists clients_delete_own on public.clients;
create policy clients_select_own on public.clients for select to authenticated using (auth.uid() = user_id);
create policy clients_insert_own on public.clients for insert to authenticated with check (auth.uid() = user_id);
create policy clients_update_own on public.clients for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Remove legacy transaction policies, including unsafe direct writes.
drop policy if exists transactions_select_own on public.transactions;
drop policy if exists transactions_insert_own on public.transactions;
drop policy if exists transactions_update_own on public.transactions;
drop policy if exists transactions_delete_own on public.transactions;
create policy transactions_select_own on public.transactions for select to authenticated
using (auth.uid() = user_id and exists (
  select 1 from public.clients c where c.id = transactions.client_id and c.user_id = auth.uid()
));

drop policy if exists migration_status_select_own on public.migration_status;
drop policy if exists migration_status_insert_own on public.migration_status;
drop policy if exists migration_status_update_own on public.migration_status;
create policy migration_status_select_own on public.migration_status for select to authenticated using (auth.uid() = user_id);

-- No client-side access to restore_history is required.

create or replace function public.current_balance(p_user_id uuid, p_client_id uuid)
returns numeric language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(sum(case type when 'DEBT' then amount when 'PAYMENT' then -amount else amount end), 0)::numeric(12,2)
  from public.transactions where user_id = p_user_id and client_id = p_client_id;
$$;
revoke all on function public.current_balance(uuid, uuid) from public, anon, authenticated;

create or replace function public.create_transaction(
  p_client_id uuid,
  p_type text,
  p_amount numeric,
  p_description text,
  p_transaction_date date,
  p_idempotency_key uuid
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_user uuid := auth.uid(); v_balance numeric(12,2); v_new numeric(12,2); v_tx public.transactions%rowtype;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
  if p_idempotency_key is null then raise exception 'IDEMPOTENCY_REQUIRED' using errcode='22023'; end if;
  if p_type not in ('DEBT','PAYMENT','ADJUSTMENT') then raise exception 'INVALID_TYPE' using errcode='22023'; end if;
  if p_amount is null or (p_type in ('DEBT','PAYMENT') and p_amount <= 0) or (p_type='ADJUSTMENT' and p_amount=0) then
    raise exception 'INVALID_AMOUNT' using errcode='22023';
  end if;
  if p_transaction_date is null then raise exception 'INVALID_DATE' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));

  select * into v_tx from public.transactions where user_id=v_user and idempotency_key=p_idempotency_key;
  if found then
    v_balance := public.current_balance(v_user, v_tx.client_id);
    return jsonb_build_object('transaction', to_jsonb(v_tx), 'balance', v_balance, 'duplicate', true);
  end if;

  perform 1 from public.clients where id=p_client_id and user_id=v_user for update;
  if not found then raise exception 'CLIENT_NOT_FOUND_OR_NOT_OWNED' using errcode='42501'; end if;

  v_balance := public.current_balance(v_user, p_client_id);
  v_new := v_balance + case when p_type='DEBT' then p_amount when p_type='PAYMENT' then -p_amount else p_amount end;
  if v_new < 0 then raise exception 'PAYMENT_EXCEEDS_BALANCE' using errcode='23514'; end if;

  insert into public.transactions(user_id,client_id,type,amount,description,transaction_date,idempotency_key)
  values(v_user,p_client_id,p_type,p_amount,nullif(trim(p_description),''),p_transaction_date,p_idempotency_key)
  returning * into v_tx;
  return jsonb_build_object('transaction', to_jsonb(v_tx), 'balance', v_new, 'duplicate', false);
end; $$;

create or replace function public.delete_empty_client(p_client_id uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  if exists(select 1 from public.transactions where user_id=v_user and client_id=p_client_id) then
    raise exception 'CLIENT_HAS_FINANCIAL_HISTORY' using errcode='23503';
  end if;
  delete from public.clients where id=p_client_id and user_id=v_user;
  if not found then raise exception 'CLIENT_NOT_FOUND_OR_NOT_OWNED' using errcode='42501'; end if;
  return true;
end; $$;

create or replace function public.import_initial_debts() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_user uuid := auth.uid(); v_count int; v_total numeric(12,2); r record; v_client uuid;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  insert into public.migration_status(user_id) values(v_user) on conflict(user_id) do nothing;
  perform 1 from public.migration_status where user_id=v_user for update;
  if (select initial_migration_done from public.migration_status where user_id=v_user) then
    raise exception 'INITIAL_MIGRATION_ALREADY_DONE' using errcode='23505';
  end if;

  for r in select * from (values
    ('Зарифа ойтимло',370.00),('Хасан ни хотуни',110.00),('Муаллими',140.00),('Шахло и мавчуда',910.00),
    ('Апай мехри',100.00),('Наргиз ямло',240.00),('Апай Дилором адаш',170.00),('Фргоналик клиент',210.00),
    ('Шахноза сердухтар',180.00),('Дилором Москва',1360.00),('Парвина тилло',180.00),('Хуршед',100.00),
    ('Шахлоя хешаш',100.00),('Шахноза сердухтар',100.00),('Адолатти авсунлари',790.00),('Апай джамила',300.00),
    ('Дилшода',260.00),('Апай шахло',7150.00),('Хусенни хотуни',370.00),('Шахло ямло',2410.00),
    ('Нигора парда',440.00),('Чаман дузанда',100.00),('Мархабо',320.00),('Апай нисо доктор',50.00),
    ('Наргиз ямло',220.00),('Орзугул апа',510.00),('Аиша Бренда апаш',50.00),('Апай нисо',460.00),
    ('Марзабо апа',1290.00),('Апай нигина уборка',330.00),('Наргиз',160.00),('Мавлюда дугона',140.00),
    ('Апай дом соз',30.00),('Насиба ойтимло',350.00),('Рано ямло',1190.00),('Шахло тилло',1780.00),
    ('Зарина',100.00),('Апай таманно',450.00),('Апай хурсанд',350.00),('Суман 988347667',100.00),
    ('Аиша бренда апаш',80.00),('Бону',50.00),('Хосият дилшода',220.00),('Вахдатлик янгамулло',600.00)
  ) as x(name, amount)
  loop
    insert into public.clients(user_id,name) values(v_user,r.name) returning id into v_client;
    insert into public.transactions(user_id,client_id,type,amount,description,transaction_date,idempotency_key)
    values(v_user,v_client,'DEBT',r.amount,'Перенесено из старой системы',current_date,gen_random_uuid());
  end loop;
  select count(*), coalesce(sum(amount),0) into v_count,v_total from public.transactions
    where user_id=v_user and description='Перенесено из старой системы';
  update public.migration_status set initial_migration_done=true,migrated_at=now(),migrated_count=44,migrated_total=24920.00 where user_id=v_user;
  return jsonb_build_object('count',44,'total',24920.00);
end; $$;

create or replace function public.restore_backup(p_backup jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_user uuid := auth.uid(); v_backup_id uuid; v_schema int; c jsonb; t jsonb;
  v_old_client uuid; v_new_client uuid; v_type text; v_amount numeric(12,2); v_balance numeric(12,2);
  v_clients int := 0; v_transactions int := 0;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
  if jsonb_typeof(p_backup) <> 'object' then raise exception 'INVALID_BACKUP' using errcode='22023'; end if;
  begin v_schema := (p_backup->>'schema_version')::int; exception when others then raise exception 'INVALID_SCHEMA_VERSION' using errcode='22023'; end;
  if v_schema <> 2 then raise exception 'UNSUPPORTED_SCHEMA_VERSION' using errcode='22023'; end if;
  begin v_backup_id := (p_backup->>'backup_id')::uuid; exception when others then raise exception 'INVALID_BACKUP_ID' using errcode='22023'; end;
  if jsonb_typeof(p_backup->'clients') <> 'array' or jsonb_typeof(p_backup->'transactions') <> 'array' then raise exception 'INVALID_BACKUP_STRUCTURE' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  if exists(select 1 from public.restore_history where user_id=v_user and backup_id=v_backup_id) then
    raise exception 'BACKUP_ALREADY_RESTORED' using errcode='23505';
  end if;

  create temp table restore_client_map(old_id uuid primary key, new_id uuid not null) on commit drop;
  -- REPLACE is intentional: validated backup becomes the complete source of truth for this user.
  delete from public.transactions where user_id=v_user;
  delete from public.clients where user_id=v_user;

  for c in select value from jsonb_array_elements(p_backup->'clients') loop
    begin v_old_client := (c->>'id')::uuid; exception when others then raise exception 'INVALID_CLIENT_ID' using errcode='22023'; end;
    if nullif(trim(c->>'name'),'') is null then raise exception 'INVALID_CLIENT_NAME' using errcode='22023'; end if;
    v_new_client := gen_random_uuid();
    insert into public.clients(id,user_id,name,phone,notes,created_at,updated_at)
    values(v_new_client,v_user,trim(c->>'name'),nullif(c->>'phone',''),nullif(c->>'notes',''),
      coalesce((c->>'created_at')::timestamptz,now()),coalesce((c->>'updated_at')::timestamptz,now()));
    insert into restore_client_map values(v_old_client,v_new_client);
    v_clients := v_clients + 1;
  end loop;

  for t in select value from jsonb_array_elements(p_backup->'transactions') order by value->>'transaction_date', value->>'created_at' loop
    begin v_old_client := (t->>'client_id')::uuid; exception when others then raise exception 'INVALID_TRANSACTION_CLIENT' using errcode='22023'; end;
    select new_id into v_new_client from restore_client_map where old_id=v_old_client;
    if v_new_client is null then raise exception 'TRANSACTION_CLIENT_MISSING' using errcode='22023'; end if;
    v_type := t->>'type';
    if v_type not in ('DEBT','PAYMENT','ADJUSTMENT') then raise exception 'INVALID_TRANSACTION_TYPE' using errcode='22023'; end if;
    begin v_amount := (t->>'amount')::numeric(12,2); exception when others then raise exception 'INVALID_TRANSACTION_AMOUNT' using errcode='22023'; end;
    if (v_type in ('DEBT','PAYMENT') and v_amount<=0) or (v_type='ADJUSTMENT' and v_amount=0) then raise exception 'INVALID_TRANSACTION_AMOUNT' using errcode='22023'; end if;
    if nullif(t->>'transaction_date','') is null then raise exception 'INVALID_TRANSACTION_DATE' using errcode='22023'; end if;
    v_balance := public.current_balance(v_user,v_new_client) + case when v_type='DEBT' then v_amount when v_type='PAYMENT' then -v_amount else v_amount end;
    if v_balance < 0 then raise exception 'BACKUP_WOULD_CREATE_NEGATIVE_BALANCE' using errcode='23514'; end if;
    insert into public.transactions(user_id,client_id,type,amount,description,transaction_date,idempotency_key,created_at)
    values(v_user,v_new_client,v_type,v_amount,nullif(t->>'description',''),(t->>'transaction_date')::date,gen_random_uuid(),coalesce((t->>'created_at')::timestamptz,now()));
    v_transactions := v_transactions + 1;
  end loop;
  insert into public.restore_history(user_id,backup_id,client_count,transaction_count) values(v_user,v_backup_id,v_clients,v_transactions);
  insert into public.migration_status(user_id,initial_migration_done,migrated_at,migrated_count,migrated_total)
  values(v_user,true,now(),null,null)
  on conflict(user_id) do update set initial_migration_done=true;
  return jsonb_build_object('clients',v_clients,'transactions',v_transactions,'mode','REPLACE');
end; $$;

revoke all on function public.create_transaction(uuid,text,numeric,text,date,uuid) from public, anon;
revoke all on function public.delete_empty_client(uuid) from public, anon;
revoke all on function public.import_initial_debts() from public, anon;
revoke all on function public.restore_backup(jsonb) from public, anon;
grant execute on function public.create_transaction(uuid,text,numeric,text,date,uuid) to authenticated;
grant execute on function public.delete_empty_client(uuid) to authenticated;
grant execute on function public.import_initial_debts() to authenticated;
grant execute on function public.restore_backup(jsonb) to authenticated;
