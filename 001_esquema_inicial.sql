-- =====================================================================
-- FACTURAS DE TRANSPORTE — 001 ESQUEMA INICIAL
-- Ejecutar UNA sola vez en Supabase > SQL Editor > New query > Run
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. UTILIDADES
-- ---------------------------------------------------------------------
create or replace function public.today_madrid()
returns date language sql stable as $$
  select (now() at time zone 'Europe/Madrid')::date;
$$;

-- ---------------------------------------------------------------------
-- 1. PERFILES (vinculados a Supabase Auth)
-- ---------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  email       text,
  role        text not null default 'user' check (role in ('admin','user')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Crea el perfil automáticamente al dar de alta un usuario en Auth
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin');
$$;

-- ---------------------------------------------------------------------
-- 2. EMPRESAS DE TRANSPORTE
-- ---------------------------------------------------------------------
create table public.transport_companies (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null unique,
  tax_id                  text,
  default_payment_method  text check (default_payment_method in
                            ('transferencia','pago_online','domiciliacion','tarjeta','otro')),
  email                   text,
  phone                   text,
  notes                   text,
  active                  boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. FACTURAS
--    "vencida" NO se guarda: se calcula en la vista invoices_view
-- ---------------------------------------------------------------------
create table public.invoices (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.transport_companies(id),
  invoice_number      text not null,
  concept             text,
  issue_date          date not null,
  service_start_date  date,
  due_date            date not null,
  subtotal            numeric(12,2),
  tax                 numeric(12,2),
  total               numeric(12,2) not null check (total >= 0),
  amount_paid         numeric(12,2) not null default 0 check (amount_paid >= 0),
  currency            text not null default 'EUR' check (char_length(currency) = 3),
  status              text not null default 'pendiente' check (status in
                        ('pendiente','parcialmente_pagada','pagada','anulada')),
  payment_date        date,
  payment_method      text check (payment_method in
                        ('transferencia','pago_online','domiciliacion','tarjeta','otro')),
  notes               text,
  file_path           text,
  created_by          uuid references public.profiles(id),
  updated_by          uuid references public.profiles(id),
  paid_by             uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint invoices_unique_number unique (company_id, invoice_number),
  constraint invoices_due_after_issue check (due_date >= issue_date)
);

create index invoices_due_date_idx on public.invoices (due_date);
create index invoices_status_idx   on public.invoices (status);
create index invoices_company_idx  on public.invoices (company_id);

-- ---------------------------------------------------------------------
-- 4. HISTORIAL (append-only: solo lo escriben los triggers)
-- ---------------------------------------------------------------------
create table public.invoice_events (
  id          bigint generated always as identity primary key,
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  event_type  text not null,   -- creada, editada, pagada, pago_parcial, anulada, reactivada, documento
  actor_id    uuid references public.profiles(id),
  details     jsonb,
  created_at  timestamptz not null default now()
);

create index invoice_events_invoice_idx on public.invoice_events (invoice_id, created_at);

-- ---------------------------------------------------------------------
-- 5. TRIGGERS
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger companies_updated_at
  before update on public.transport_companies
  for each row execute function public.set_updated_at();

-- Registra quién crea / modifica / paga, sin depender del navegador
create or replace function public.invoices_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
  else
    new.created_by := old.created_by;   -- no modificable
    new.created_at := old.created_at;   -- no modificable
    new.updated_by := auth.uid();
    new.updated_at := now();
  end if;

  if new.status = 'pagada' and (tg_op = 'INSERT' or old.status is distinct from 'pagada') then
    new.paid_by      := auth.uid();
    new.payment_date := coalesce(new.payment_date, public.today_madrid());
    new.amount_paid  := new.total;
  elsif new.status <> 'pagada' and tg_op = 'UPDATE' and old.status = 'pagada' then
    new.paid_by      := null;
    new.payment_date := null;
  end if;

  return new;
end $$;

create trigger invoices_before_write
  before insert or update on public.invoices
  for each row execute function public.invoices_before_write();

create or replace function public.invoices_log_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type    text;
  v_details jsonb;
begin
  if tg_op = 'INSERT' then
    v_type := 'creada';
    v_details := jsonb_build_object('total', new.total, 'status', new.status);
  else
    select jsonb_object_agg(n.key, jsonb_build_object('antes', o.value, 'despues', n.value))
      into v_details
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value
       and n.key not in ('updated_at','updated_by');

    if v_details is null then
      return new;  -- sin cambios reales
    end if;

    if new.status is distinct from old.status then
      v_type := case new.status
                  when 'pagada'              then 'pagada'
                  when 'parcialmente_pagada' then 'pago_parcial'
                  when 'anulada'             then 'anulada'
                  else 'reactivada'
                end;
    elsif new.file_path is distinct from old.file_path then
      v_type := 'documento';
    else
      v_type := 'editada';
    end if;
  end if;

  insert into public.invoice_events (invoice_id, event_type, actor_id, details)
  values (new.id, v_type, auth.uid(), v_details);
  return new;
end $$;

create trigger invoices_log_event
  after insert or update on public.invoices
  for each row execute function public.invoices_log_event();

-- ---------------------------------------------------------------------
-- 6. VISTA CON ESTADO CALCULADO (vencida automática, hora de Madrid)
-- ---------------------------------------------------------------------
create view public.invoices_view
with (security_invoker = true) as
select
  i.*,
  c.name                                        as company_name,
  case
    when i.status in ('pendiente','parcialmente_pagada')
     and i.due_date < public.today_madrid() then 'vencida'
    else i.status
  end                                           as effective_status,
  (i.due_date - public.today_madrid())          as days_to_due,
  (i.total - i.amount_paid)                     as amount_due,
  pc.full_name                                  as created_by_name,
  pp.full_name                                  as paid_by_name
from public.invoices i
join public.transport_companies c on c.id = i.company_id
left join public.profiles pc on pc.id = i.created_by
left join public.profiles pp on pp.id = i.paid_by;

-- ---------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY (solo usuarios autenticados y activos)
-- ---------------------------------------------------------------------
alter table public.profiles            enable row level security;
alter table public.transport_companies enable row level security;
alter table public.invoices            enable row level security;
alter table public.invoice_events      enable row level security;

create policy profiles_select on public.profiles
  for select to authenticated using (public.is_active_user());

create policy companies_select on public.transport_companies
  for select to authenticated using (public.is_active_user());
create policy companies_insert on public.transport_companies
  for insert to authenticated with check (public.is_active_user());
create policy companies_update on public.transport_companies
  for update to authenticated using (public.is_active_user()) with check (public.is_active_user());

create policy invoices_select on public.invoices
  for select to authenticated using (public.is_active_user());
create policy invoices_insert on public.invoices
  for insert to authenticated with check (public.is_active_user());
create policy invoices_update on public.invoices
  for update to authenticated using (public.is_active_user()) with check (public.is_active_user());

create policy invoice_events_select on public.invoice_events
  for select to authenticated using (public.is_active_user());

-- Sin DELETE en ninguna tabla: las facturas se anulan, no se borran.

-- ---------------------------------------------------------------------
-- 8. PERMISOS (la exposición automática está desactivada)
-- ---------------------------------------------------------------------
revoke all on public.profiles, public.transport_companies, public.invoices,
              public.invoice_events, public.invoices_view from anon;

grant usage on schema public to authenticated;
grant select                 on public.profiles            to authenticated;
grant select, insert, update on public.transport_companies to authenticated;
grant select, insert, update on public.invoices            to authenticated;
grant select                 on public.invoice_events      to authenticated;
grant select                 on public.invoices_view       to authenticated;
grant execute on function public.is_active_user(), public.is_admin(), public.today_madrid()
  to authenticated;

-- ---------------------------------------------------------------------
-- 9. ALMACENAMIENTO DE PDFs (bucket privado, máx. 10 MB por archivo)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('facturas', 'facturas', false, 10485760,
        array['application/pdf','image/jpeg','image/png','image/webp','image/heic']);

create policy facturas_files_select on storage.objects
  for select to authenticated
  using (bucket_id = 'facturas' and public.is_active_user());

create policy facturas_files_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'facturas' and public.is_active_user());

create policy facturas_files_update on storage.objects
  for update to authenticated
  using (bucket_id = 'facturas' and public.is_active_user())
  with check (bucket_id = 'facturas' and public.is_active_user());

-- ---------------------------------------------------------------------
-- 10. EMPRESAS INICIALES
-- ---------------------------------------------------------------------
insert into public.transport_companies (name, default_payment_method) values
  ('UPS',       'pago_online'),
  ('FEDEX',     'pago_online'),
  ('MBE',       'transferencia'),
  ('MOLDTRANS', 'transferencia'),
  ('TXT',       'transferencia'),
  ('LPS',       'domiciliacion');
