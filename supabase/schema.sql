-- ============================================================================
--  NOVA POS — esquema completo
--  Pegá TODO este archivo en Supabase → SQL Editor → Run. Se puede correr
--  varias veces sin romper nada.
--
--  Idea de seguridad: el ayudante NO tiene permiso de leer ni escribir
--  inventario ni movimientos. Aun así sus ventas descuentan vasos, porque el
--  descuento lo hace un trigger de la base de datos (SECURITY DEFINER), no su
--  celular. Cambiar la app en su teléfono no le sirve de nada: el servidor manda.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- perfiles --

create table if not exists public.perfiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  nombre     text,
  rol        text not null default 'ayudante' check (rol in ('dueno', 'ayudante')),
  creado_en  timestamptz not null default now()
);

-- El PRIMER usuario que se cree es el dueño. Los demás entran como ayudantes
-- y el dueño los asciende desde Ajustes si hace falta.
create or replace function public.nuevo_perfil()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  hay_alguno boolean;
begin
  select exists (select 1 from public.perfiles) into hay_alguno;
  insert into public.perfiles (id, email, nombre, rol)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'nombre', split_part(new.email, '@', 1)),
    case when hay_alguno then 'ayudante' else 'dueno' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists al_crear_usuario on auth.users;
create trigger al_crear_usuario
  after insert on auth.users
  for each row execute function public.nuevo_perfil();

-- Consultar el rol sin disparar RLS recursivo sobre la propia tabla perfiles.
create or replace function public.es_dueno()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select rol = 'dueno' from public.perfiles where id = auth.uid()),
    false
  );
$$;

-- ---------------------------------------------------------------- negocio ---

create table if not exists public.productos (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  categoria  text default 'otro',
  oz         int,
  precio     bigint not null default 0,
  vaso       text check (vaso in ('icopor', 'plastico')),
  orden      int default 0,
  activo     boolean not null default true,
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);

create table if not exists public.cuentas (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  nota        text default '',
  estado      text not null default 'abierta' check (estado in ('abierta', 'cerrada')),
  creada_por  text default '',
  created_at  timestamptz not null default now(),
  closed_at   timestamptz,
  fecha       date not null default current_date,
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false
);

create table if not exists public.items (
  id           uuid primary key default gen_random_uuid(),
  cuenta_id    uuid not null references public.cuentas(id) on delete cascade,
  producto_id  uuid,
  nombre       text not null,
  precio       bigint not null default 0,
  cantidad     int not null default 1 check (cantidad >= 0),
  pagadas      int not null default 0 check (pagadas >= 0),
  vaso         text check (vaso in ('icopor', 'plastico')),
  oz           int,
  vendido_por  text default '',
  created_at   timestamptz not null default now(),
  fecha        date not null default current_date,
  updated_at   timestamptz not null default now(),
  deleted      boolean not null default false,
  constraint pagadas_no_supera_cantidad check (pagadas <= cantidad)
);

create table if not exists public.pagos (
  id          uuid primary key default gen_random_uuid(),
  cuenta_id   uuid not null references public.cuentas(id) on delete cascade,
  monto       bigint not null check (monto > 0),
  metodo      text not null default 'Efectivo',
  quien       text default '',
  nota        text default '',
  cubre       jsonb default '[]'::jsonb,
  cobrado_por text default '',
  created_at  timestamptz not null default now(),
  fecha       date not null default current_date,
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false
);

-- El vaso plástico es de un solo tipo y no lleva onzas: su fila tiene oz nulo.
-- Por eso la unicidad se define sobre coalesce(oz, 0) y no sobre oz a secas,
-- que en Postgres dejaría entrar varios nulos repetidos.
create table if not exists public.inventario (
  id         uuid primary key default gen_random_uuid(),
  tipo       text not null check (tipo in ('icopor', 'plastico')),
  oz         int,
  stock      int not null default 0,
  minimo     int not null default 20,
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);

alter table public.inventario alter column oz drop not null;
alter table public.inventario drop constraint if exists inventario_tipo_oz_key;

-- Los vasos plásticos con tamaño son de una versión anterior: se consolidan
-- en una sola fila sumando lo que hubiera en cada una.
do $$
begin
  if exists (select 1 from public.inventario where tipo = 'plastico' and oz is not null) then
    insert into public.inventario (tipo, oz, stock, minimo)
    select 'plastico', null, sum(stock), min(minimo)
    from public.inventario where tipo = 'plastico' and oz is not null;

    delete from public.inventario where tipo = 'plastico' and oz is not null;
  end if;
end $$;

create unique index if not exists inventario_vaso_uq
  on public.inventario (tipo, coalesce(oz, 0));

create table if not exists public.movimientos (
  id         uuid primary key default gen_random_uuid(),
  tipo_vaso  text not null,
  oz         int,
  delta      int not null,
  motivo     text not null default 'ajuste',
  cuenta_id  uuid,
  nota       text default '',
  fecha      date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);

alter table public.movimientos alter column oz drop not null;

create index if not exists items_cuenta_idx   on public.items (cuenta_id);
create index if not exists pagos_cuenta_idx   on public.pagos (cuenta_id);
create index if not exists cuentas_estado_idx on public.cuentas (estado);
create index if not exists items_upd_idx      on public.items (updated_at);
create index if not exists pagos_upd_idx      on public.pagos (updated_at);
create index if not exists cuentas_upd_idx    on public.cuentas (updated_at);

-- --------------------------------------------------- reloj del servidor -----
-- El watermark de sincronización tiene que venir de UN solo reloj. Si cada
-- celular pusiera su hora, uno adelantado se "comería" cambios del otro.

create or replace function public.marcar_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['productos','cuentas','items','pagos','inventario','movimientos']
  loop
    execute format('drop trigger if exists tg_updated_at on public.%I', t);
    execute format(
      'create trigger tg_updated_at before insert or update on public.%I
       for each row execute function public.marcar_updated_at()', t);
  end loop;
end $$;

-- ------------------------------------------- descuento de vasos por venta ---
-- Corre como dueño de la función, así el ayudante descuenta stock sin tener
-- ningún permiso sobre inventario.

create or replace function public.mover_inventario_por_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  vaso_ant text; oz_ant int; cant_ant int;
  vaso_nue text; oz_nue int; cant_nue int;
begin
  -- Cantidad "efectiva": una línea borrada cuenta como cero.
  if TG_OP = 'INSERT' then
    vaso_ant := null; oz_ant := null; cant_ant := 0;
  else
    vaso_ant := OLD.vaso; oz_ant := OLD.oz;
    cant_ant := case when OLD.deleted then 0 else OLD.cantidad end;
  end if;

  if TG_OP = 'DELETE' then
    vaso_nue := null; oz_nue := null; cant_nue := 0;
  else
    vaso_nue := NEW.vaso; oz_nue := NEW.oz;
    cant_nue := case when NEW.deleted then 0 else NEW.cantidad end;
  end if;

  -- Si cambió de producto (otro vaso u otra onza), se devuelve el viejo entero.
  if vaso_ant is distinct from vaso_nue or oz_ant is distinct from oz_nue then
    if vaso_ant is not null and cant_ant <> 0 then
      perform public.aplicar_stock(vaso_ant, oz_ant, cant_ant, 'devolucion',
                                   coalesce(OLD.cuenta_id, NEW.cuenta_id), OLD.nombre);
    end if;
    if vaso_nue is not null and cant_nue <> 0 then
      perform public.aplicar_stock(vaso_nue, oz_nue, -cant_nue, 'venta',
                                   NEW.cuenta_id, NEW.nombre);
    end if;
  elsif vaso_nue is not null and cant_nue <> cant_ant then
    perform public.aplicar_stock(
      vaso_nue, oz_nue, -(cant_nue - cant_ant),
      case when cant_nue > cant_ant then 'venta' else 'devolucion' end,
      coalesce(NEW.cuenta_id, OLD.cuenta_id),
      coalesce(NEW.nombre, OLD.nombre));
  end if;

  return coalesce(NEW, OLD);
end;
$$;

create or replace function public.aplicar_stock(
  p_tipo text, p_oz int, p_delta int, p_motivo text, p_cuenta uuid, p_nota text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- p_oz nulo es válido: así es el vaso plástico, que no tiene tamaño.
  if p_tipo is null or p_delta = 0 then return; end if;

  insert into public.inventario (tipo, oz, stock)
  values (p_tipo, p_oz, p_delta)
  on conflict (tipo, coalesce(oz, 0))
  do update set stock = public.inventario.stock + p_delta;

  insert into public.movimientos (tipo_vaso, oz, delta, motivo, cuenta_id, nota)
  values (p_tipo, p_oz, p_delta, p_motivo, p_cuenta, coalesce(p_nota, ''));
end;
$$;

drop trigger if exists tg_stock_items on public.items;
create trigger tg_stock_items
  after insert or update or delete on public.items
  for each row execute function public.mover_inventario_por_item();

-- ====================================================== permisos (RLS) ======

alter table public.perfiles    enable row level security;
alter table public.productos   enable row level security;
alter table public.cuentas     enable row level security;
alter table public.items       enable row level security;
alter table public.pagos       enable row level security;
alter table public.inventario  enable row level security;
alter table public.movimientos enable row level security;

do $$
declare t text; p record;
begin
  foreach t in array array['perfiles','productos','cuentas','items','pagos','inventario','movimientos']
  loop
    for p in select policyname from pg_policies
             where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- perfiles: cada quien se ve a sí mismo; el dueño ve y administra a todos.
create policy perfil_propio on public.perfiles
  for select to authenticated
  using (id = auth.uid() or public.es_dueno());

create policy perfil_admin on public.perfiles
  for update to authenticated
  using (public.es_dueno()) with check (public.es_dueno());

-- productos: todos los ven (el ayudante necesita precios para vender),
-- pero solo el dueño los crea o cambia.
create policy productos_ver on public.productos
  for select to authenticated using (true);

create policy productos_editar on public.productos
  for all to authenticated
  using (public.es_dueno()) with check (public.es_dueno());

-- cuentas / items / pagos: el trabajo diario.
--
-- El dueño ve todo el historial. El ayudante ve solo el turno en el que está:
-- lo de hoy, más cualquier cuenta que siga abierta aunque sea de otro día,
-- porque sin eso no podría cobrarle a quien quedó debiendo.
-- Lo de ayer, ya cerrado, para él deja de existir.

-- El día de negocio lo define el servidor, no el celular: corta a las 5 am
-- hora de Colombia, igual que en la app.
create or replace function public.dia_negocio()
returns date
language sql
stable
as $$
  select (((now() at time zone 'America/Bogota') - interval '5 hours')::date);
$$;

-- Un ítem o un pago se ve si su cuenta se ve. Va como SECURITY DEFINER para
-- que la consulta a cuentas no vuelva a pasar por las políticas de cuentas.
create or replace function public.cuenta_del_turno(p_cuenta uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.cuentas c
     where c.id = p_cuenta
       and (c.fecha >= public.dia_negocio() or c.estado = 'abierta')
  );
$$;

create policy cuentas_ver on public.cuentas
  for select to authenticated
  using (public.es_dueno() or fecha >= public.dia_negocio() or estado = 'abierta');

create policy cuentas_crear on public.cuentas
  for insert to authenticated with check (true);

create policy cuentas_editar on public.cuentas
  for update to authenticated
  using (public.es_dueno() or fecha >= public.dia_negocio() or estado = 'abierta')
  with check (true);

do $$
declare t text;
begin
  foreach t in array array['items','pagos']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated
       using (public.es_dueno() or fecha >= public.dia_negocio()
              or public.cuenta_del_turno(cuenta_id))',
      t || '_ver', t);

    execute format(
      'create policy %I on public.%I for insert to authenticated with check (true)',
      t || '_crear', t);

    execute format(
      'create policy %I on public.%I for update to authenticated
       using (public.es_dueno() or fecha >= public.dia_negocio()
              or public.cuenta_del_turno(cuenta_id))
       with check (true)',
      t || '_editar', t);
  end loop;
end $$;

-- Nadie borra con DELETE: al no existir política de delete, queda prohibido
-- para todos. Las anulaciones marcan deleted y dejan rastro.

-- inventario y movimientos: EXCLUSIVOS del dueño.
-- Sin política que los habilite, el ayudante ni siquiera los ve existir:
-- un select le devuelve cero filas y un insert le da error de permisos.
do $$
declare t text;
begin
  foreach t in array array['inventario','movimientos']
  loop
    execute format(
      'create policy %I on public.%I for all to authenticated
       using (public.es_dueno()) with check (public.es_dueno())',
      t || '_solo_dueno', t);
  end loop;
end $$;

-- ================================================== cambios en vivo =========
-- Para que lo que hace un celular aparezca en el otro sin recargar.

do $$
declare t text;
begin
  foreach t in array array['productos','cuentas','items','pagos','inventario','movimientos']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- Realtime respeta RLS: el ayudante no recibe eventos de inventario.
alter table public.cuentas     replica identity full;
alter table public.items       replica identity full;
alter table public.pagos       replica identity full;
alter table public.productos   replica identity full;
alter table public.inventario  replica identity full;
alter table public.movimientos replica identity full;

-- =============================== inventario inicial de vasos ================
-- Arranca en cero: cargá las cantidades reales desde la app (Inventario → Mover).

insert into public.inventario (tipo, oz, stock, minimo) values
  ('icopor', 8, 0, 20), ('icopor', 12, 0, 20), ('icopor', 16, 0, 20), ('icopor', 24, 0, 20),
  ('plastico', null, 0, 20)
on conflict (tipo, coalesce(oz, 0)) do nothing;

-- ================================ catálogo inicial ==========================

-- Antes del índice hay que limpiar duplicados que hubiera dejado una corrida
-- anterior; si no, el índice único no se puede crear. Se conserva el más viejo.
delete from public.productos p
 where p.deleted = false
   and exists (
     select 1 from public.productos q
      where q.deleted = false
        and q.nombre = p.nombre
        and (q.updated_at, q.id) < (p.updated_at, p.id)
   );

create unique index if not exists productos_nombre_uq
  on public.productos (nombre) where not deleted;

insert into public.productos (nombre, categoria, oz, precio, vaso, orden) values
  ('Cremoso 8 oz',   'cremoso',   8,    13000, 'icopor',   1),
  ('Cremoso 12 oz',  'cremoso',   12,   17000, 'icopor',   2),
  ('Cremoso 16 oz',  'cremoso',   16,   22000, 'icopor',   3),
  ('Cremoso 24 oz',  'cremoso',   24,   30000, 'icopor',   4),
  ('Original 8 oz',  'original',  8,    11000, 'icopor',   5),
  ('Original 12 oz', 'original',  12,   13000, 'icopor',   6),
  ('Original 16 oz', 'original',  16,   17000, 'icopor',   7),
  ('Original 24 oz', 'original',  24,   23000, 'icopor',   8),
  ('Michelada',      'michelada', null, 12000, 'plastico', 9)
on conflict (nombre) where not deleted do nothing;

-- Restos del catálogo anterior: micheladas con tamaño y cócteles de relleno.
-- Se ocultan en vez de borrarse, para no romper ventas ya registradas.
update public.productos
   set activo = false, deleted = true
 where nombre in ('Michelada 16 oz', 'Michelada 24 oz', 'Coctel 12 oz', 'Coctel 16 oz');
