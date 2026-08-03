-- МАГАЗИН: additive migration. Run ONCE after the existing debt schema.
-- Does not drop or recreate clients/transactions and preserves all debt data/RPCs.
create extension if not exists pgcrypto;

create table if not exists public.products (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(char_length(trim(name)) between 1 and 200), category text, sale_price numeric(12,2) check(sale_price is null or sale_price>=0),
 purchase_price numeric(12,2) check(purchase_price is null or purchase_price>=0), stock_quantity integer not null default 0 check(stock_quantity>=0),
 notes text, active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,user_id));
create table if not exists public.sales (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 total_amount numeric(12,2) not null check(total_amount>0), cost_total numeric(12,2) check(cost_total is null or cost_total>=0), description text,
 payment_method text not null check(payment_method in('cash','transfer','other','debt')), client_id uuid,
 sale_date date not null default current_date, status text not null default 'completed' check(status in('completed','cancelled')),
 idempotency_key uuid not null, created_at timestamptz not null default now(), cancelled_at timestamptz,
 unique(user_id,idempotency_key), foreign key(client_id,user_id) references public.clients(id,user_id) on delete restrict);
create table if not exists public.sale_items (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 sale_id uuid not null, product_id uuid, product_name text, quantity integer not null default 1 check(quantity>0), unit_price numeric(12,2), unit_cost numeric(12,2),
 created_at timestamptz not null default now(), foreign key(sale_id,user_id) references public.sales(id,user_id) on delete restrict,
 foreign key(product_id,user_id) references public.products(id,user_id) on delete restrict);
create table if not exists public.expenses (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 amount numeric(12,2) not null check(amount>0), category text not null, description text, expense_date date not null default current_date,
 status text not null default 'completed' check(status in('completed','cancelled')), purchase_id uuid, created_at timestamptz not null default now(), cancelled_at timestamptz);
create table if not exists public.purchases (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 product_id uuid not null, quantity integer not null check(quantity>0), unit_cost numeric(12,2) not null check(unit_cost>=0), total_cost numeric(12,2) not null check(total_cost>=0),
 supplier text, comment text, purchase_date date not null default current_date, status text not null default 'completed' check(status in('completed','cancelled')),
 idempotency_key uuid not null, created_at timestamptz not null default now(), cancelled_at timestamptz,
 unique(user_id,idempotency_key), unique(id,user_id), foreign key(product_id,user_id) references public.products(id,user_id) on delete restrict);

do $$ begin if not exists(select 1 from pg_constraint where conname='sales_id_user_unique') then alter table public.sales add constraint sales_id_user_unique unique(id,user_id); end if; end $$;
create index if not exists idx_sales_user_date on public.sales(user_id,sale_date desc);create index if not exists idx_expenses_user_date on public.expenses(user_id,expense_date desc);create index if not exists idx_purchases_user_date on public.purchases(user_id,purchase_date desc);create index if not exists idx_products_user_active on public.products(user_id,active);

alter table public.products enable row level security;alter table public.sales enable row level security;alter table public.sale_items enable row level security;alter table public.expenses enable row level security;alter table public.purchases enable row level security;
-- Read/write only own simple master data. Multi-entity financial mutations use RPC.
do $$ declare t text; begin foreach t in array array['products','sales','sale_items','expenses','purchases'] loop execute format('drop policy if exists %I_select_own on public.%I',t,t); execute format('create policy %I_select_own on public.%I for select to authenticated using (auth.uid()=user_id)',t,t); end loop; end $$;
drop policy if exists products_insert_own on public.products;drop policy if exists products_update_own on public.products;
create policy products_insert_own on public.products for insert to authenticated with check(auth.uid()=user_id);create policy products_update_own on public.products for update to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
drop policy if exists expenses_insert_own on public.expenses;drop policy if exists expenses_update_own on public.expenses;
create policy expenses_insert_own on public.expenses for insert to authenticated with check(auth.uid()=user_id and purchase_id is null);create policy expenses_update_own on public.expenses for update to authenticated using(auth.uid()=user_id and purchase_id is null) with check(auth.uid()=user_id and purchase_id is null);

create or replace function public.create_sale(p_amount numeric,p_description text,p_quantity integer,p_payment_method text,p_sale_date date,p_product_id uuid,p_client_id uuid,p_idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u uuid:=auth.uid(); s public.sales%rowtype; p public.products%rowtype; tx public.transactions%rowtype; c numeric(12,2);begin
 if u is null then raise exception 'AUTH_REQUIRED'; end if;if p_amount<=0 or p_quantity<=0 then raise exception 'INVALID_AMOUNT';end if;if p_payment_method not in('cash','transfer','other','debt') then raise exception 'INVALID_PAYMENT_METHOD';end if;if p_payment_method='debt' and p_client_id is null then raise exception 'CLIENT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));select * into s from public.sales where user_id=u and idempotency_key=p_idempotency_key;if found then return to_jsonb(s);end if;
 if p_client_id is not null then perform 1 from public.clients where id=p_client_id and user_id=u for update;if not found then raise exception 'CLIENT_NOT_FOUND_OR_NOT_OWNED';end if;end if;
 if p_product_id is not null then select * into p from public.products where id=p_product_id and user_id=u and active=true for update;if not found then raise exception 'PRODUCT_NOT_FOUND';end if;if p.stock_quantity<p_quantity then raise exception 'INSUFFICIENT_STOCK';end if;c:=case when p.purchase_price is null then null else p.purchase_price*p_quantity end;end if;
 insert into public.sales(user_id,total_amount,cost_total,description,payment_method,client_id,sale_date,idempotency_key) values(u,p_amount,c,nullif(trim(p_description),''),p_payment_method,p_client_id,p_sale_date,p_idempotency_key) returning * into s;
 if p_product_id is not null then insert into public.sale_items(user_id,sale_id,product_id,product_name,quantity,unit_price,unit_cost) values(u,s.id,p.id,p.name,p_quantity,p_amount/p_quantity,p.purchase_price);update public.products set stock_quantity=stock_quantity-p_quantity,updated_at=now() where id=p.id;end if;
 if p_payment_method='debt' then insert into public.transactions(user_id,client_id,type,amount,description,transaction_date,idempotency_key) values(u,p_client_id,'DEBT',p_amount,coalesce(nullif(trim(p_description),''),'Продажа в долг'),p_sale_date,p_idempotency_key) returning * into tx;end if;
 return to_jsonb(s);end $$;

create or replace function public.cancel_sale(p_sale_id uuid) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare u uuid:=auth.uid();s public.sales%rowtype;i record;bal numeric(12,2);begin if u is null then raise exception 'AUTH_REQUIRED';end if;perform pg_advisory_xact_lock(hashtextextended(u::text,0));select * into s from public.sales where id=p_sale_id and user_id=u for update;if not found then raise exception 'SALE_NOT_FOUND';end if;if s.status='cancelled' then return true;end if;
 if s.payment_method='debt' then bal:=public.current_balance(u,s.client_id);if bal<s.total_amount then raise exception 'CANNOT_CANCEL_DEBT_SALE_AFTER_PAYMENT';end if;insert into public.transactions(user_id,client_id,type,amount,description,transaction_date,idempotency_key) values(u,s.client_id,'ADJUSTMENT',-s.total_amount,'Отмена продажи в долг',current_date,gen_random_uuid());end if;
 for i in select * from public.sale_items where sale_id=s.id and user_id=u loop if i.product_id is not null then update public.products set stock_quantity=stock_quantity+i.quantity,updated_at=now() where id=i.product_id and user_id=u;end if;end loop;update public.sales set status='cancelled',cancelled_at=now() where id=s.id;return true;end $$;

create or replace function public.create_purchase(p_product_id uuid,p_quantity integer,p_unit_cost numeric,p_supplier text,p_comment text,p_purchase_date date,p_idempotency_key uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare u uuid:=auth.uid();p public.products%rowtype;r public.purchases%rowtype;begin if u is null then raise exception 'AUTH_REQUIRED';end if;if p_quantity<=0 or p_unit_cost<0 then raise exception 'INVALID_PURCHASE';end if;perform pg_advisory_xact_lock(hashtextextended(u::text,0));select * into r from public.purchases where user_id=u and idempotency_key=p_idempotency_key;if found then return to_jsonb(r);end if;select * into p from public.products where id=p_product_id and user_id=u for update;if not found then raise exception 'PRODUCT_NOT_FOUND';end if;insert into public.purchases(user_id,product_id,quantity,unit_cost,total_cost,supplier,comment,purchase_date,idempotency_key) values(u,p.id,p_quantity,p_unit_cost,p_quantity*p_unit_cost,nullif(trim(p_supplier),''),nullif(trim(p_comment),''),p_purchase_date,p_idempotency_key) returning * into r;update public.products set stock_quantity=stock_quantity+p_quantity,purchase_price=p_unit_cost,updated_at=now() where id=p.id;insert into public.expenses(user_id,amount,category,description,expense_date,purchase_id) values(u,r.total_cost,'Закуп товара',coalesce('Закупка: '||p.name,'Закуп товара'),p_purchase_date,r.id);return to_jsonb(r);end $$;
create or replace function public.cancel_purchase(p_purchase_id uuid) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$ declare u uuid:=auth.uid();r public.purchases%rowtype;begin if u is null then raise exception 'AUTH_REQUIRED';end if;perform pg_advisory_xact_lock(hashtextextended(u::text,0));select * into r from public.purchases where id=p_purchase_id and user_id=u for update;if not found then raise exception 'PURCHASE_NOT_FOUND';end if;if r.status='cancelled' then return true;end if;perform 1 from public.products where id=r.product_id and user_id=u and stock_quantity>=r.quantity for update;if not found then raise exception 'CANNOT_CANCEL_PURCHASE_STOCK_ALREADY_USED';end if;update public.products set stock_quantity=stock_quantity-r.quantity,updated_at=now() where id=r.product_id;update public.purchases set status='cancelled',cancelled_at=now() where id=r.id;update public.expenses set status='cancelled',cancelled_at=now() where purchase_id=r.id and user_id=u;return true;end $$;
revoke all on function public.create_sale(numeric,text,integer,text,date,uuid,uuid,uuid) from public,anon;grant execute on function public.create_sale(numeric,text,integer,text,date,uuid,uuid,uuid) to authenticated;
revoke all on function public.cancel_sale(uuid) from public,anon;grant execute on function public.cancel_sale(uuid) to authenticated;
revoke all on function public.create_purchase(uuid,integer,numeric,text,text,date,uuid) from public,anon;grant execute on function public.create_purchase(uuid,integer,numeric,text,text,date,uuid) to authenticated;
revoke all on function public.cancel_purchase(uuid) from public,anon;grant execute on function public.cancel_purchase(uuid) to authenticated;
