-- ============================================================================
--  NOVA POS — sedes
--
--  Pegá este archivo en Supabase → SQL Editor → Run.
--  Se puede correr varias veces sin romper nada.
--
--  Qué cambia: cada cuenta, venta, pago y vaso pertenece a una sede. Cada sede
--  lleva su propio inventario, así que una venta en la Sede Exterior descuenta
--  de los vasos de la Exterior y no toca los de la Principal.
--
--  Lo que ya existía queda asignado a la Sede Principal.
-- ============================================================================

create table if not exists public.sedes (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  orden      int  not null default 0,
  activa     boolean not null default true,
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);

create unique index if not exists sedes_nombre_uq
  on public.sedes (nombre) where not deleted;

insert into public.sedes (nombre, orden) values
  ('Sede Principal', 1),
  ('Sede Exterior',  2)
on conflict (nombre) where not deleted do nothing;

-- Marca de tiempo del servidor, igual que en el resto de las tablas.
drop trigger if exists tg_updated_at on public.sedes;
create trigger tg_updated_at
  before insert or update on public.sedes
  for each row execute function public.marcar_updated_at();

-- ------------------------------------------------ columna sede en todo ------

alter table public.cuentas     add column if not exists sede_id uuid references public.sedes(id);
alter table public.items       add column if not exists sede_id uuid references public.sedes(id);
alter table public.pagos       add column if not exists sede_id uuid references public.sedes(id);
alter table public.inventario  add column if not exists sede_id uuid references public.sedes(id);
alter table public.movimientos add column if not exists sede_id uuid references public.sedes(id);

-- Lo que se registró antes de tener sedes pertenece a la Principal.
do $$
declare principal uuid;
begin
  select id into principal from public.sedes
   where nombre = 'Sede Principal' and not deleted limit 1;

  update public.cuentas     set sede_id = principal where sede_id is null;
  update public.items       set sede_id = principal where sede_id is null;
  update public.pagos       set sede_id = principal where sede_id is null;
  update public.movimientos set sede_id = principal where sede_id is null;

  -- El inventario viejo era uno solo: pasa a ser el de la Principal.
  update public.inventario  set sede_id = principal where sede_id is null;
end $$;

create index if not exists cuentas_sede_idx on public.cuentas (sede_id);
create index if not exists items_sede_idx   on public.items (sede_id);
create index if not exists pagos_sede_idx   on public.pagos (sede_id);

-- ------------------------------------- inventario: una fila por sede --------
-- La unicidad pasa de (tipo, oz) a (sede, tipo, oz). Sin esto, las dos sedes
-- pelearían por la misma fila y el stock de una pisaría el de la otra.

drop index if exists public.inventario_vaso_uq;

create unique index if not exists inventario_sede_vaso_uq
  on public.inventario (sede_id, tipo, coalesce(oz, 0));

-- Cada sede arranca con sus cinco filas de vasos en cero.
insert into public.inventario (sede_id, tipo, oz, stock, minimo)
select s.id, v.tipo, v.oz, 0, 20
  from public.sedes s
 cross join (values
   ('icopor', 8), ('icopor', 12), ('icopor', 16), ('icopor', 24),
   ('plastico', null::int)
 ) as v(tipo, oz)
 where not s.deleted
on conflict (sede_id, tipo, coalesce(oz, 0)) do nothing;

-- --------------------------- descuento de vasos, ahora por sede -------------

create or replace function public.aplicar_stock(
  p_sede uuid, p_tipo text, p_oz int, p_delta int,
  p_motivo text, p_cuenta uuid, p_nota text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- p_oz nulo es válido: así es el vaso plástico, que no tiene tamaño.
  -- Sin sede no se mueve nada: mejor no descontar que descontar en el local
  -- equivocado, porque eso descuadra las dos sedes a la vez.
  if p_sede is null or p_tipo is null or p_delta = 0 then return; end if;

  insert into public.inventario (sede_id, tipo, oz, stock)
  values (p_sede, p_tipo, p_oz, p_delta)
  on conflict (sede_id, tipo, coalesce(oz, 0))
  do update set stock = public.inventario.stock + p_delta;

  insert into public.movimientos (sede_id, tipo_vaso, oz, delta, motivo, cuenta_id, nota)
  values (p_sede, p_tipo, p_oz, p_delta, p_motivo, p_cuenta, coalesce(p_nota, ''));
end;
$$;

-- La versión vieja de 6 parámetros queda huérfana: se elimina para que nadie
-- la llame por error y mueva stock sin sede.
drop function if exists public.aplicar_stock(text, int, int, text, uuid, text);

create or replace function public.mover_inventario_por_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  vaso_ant text; oz_ant int; cant_ant int; sede_ant uuid;
  vaso_nue text; oz_nue int; cant_nue int; sede_nue uuid;
begin
  -- Cantidad "efectiva": una línea borrada cuenta como cero.
  if TG_OP = 'INSERT' then
    vaso_ant := null; oz_ant := null; cant_ant := 0; sede_ant := null;
  else
    vaso_ant := OLD.vaso; oz_ant := OLD.oz; sede_ant := OLD.sede_id;
    cant_ant := case when OLD.deleted then 0 else OLD.cantidad end;
  end if;

  if TG_OP = 'DELETE' then
    vaso_nue := null; oz_nue := null; cant_nue := 0; sede_nue := null;
  else
    vaso_nue := NEW.vaso; oz_nue := NEW.oz; sede_nue := NEW.sede_id;
    cant_nue := case when NEW.deleted then 0 else NEW.cantidad end;
  end if;

  -- Si cambió de vaso, de onzas o de sede, se devuelve el viejo entero y se
  -- descuenta el nuevo donde corresponde.
  if vaso_ant is distinct from vaso_nue
     or oz_ant is distinct from oz_nue
     or sede_ant is distinct from sede_nue then

    if vaso_ant is not null and cant_ant <> 0 then
      perform public.aplicar_stock(sede_ant, vaso_ant, oz_ant, cant_ant, 'devolucion',
                                   coalesce(OLD.cuenta_id, NEW.cuenta_id), OLD.nombre);
    end if;
    if vaso_nue is not null and cant_nue <> 0 then
      perform public.aplicar_stock(sede_nue, vaso_nue, oz_nue, -cant_nue, 'venta',
                                   NEW.cuenta_id, NEW.nombre);
    end if;

  elsif vaso_nue is not null and cant_nue <> cant_ant then
    perform public.aplicar_stock(
      sede_nue, vaso_nue, oz_nue, -(cant_nue - cant_ant),
      case when cant_nue > cant_ant then 'venta' else 'devolucion' end,
      coalesce(NEW.cuenta_id, OLD.cuenta_id),
      coalesce(NEW.nombre, OLD.nombre));
  end if;

  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists tg_stock_items on public.items;
create trigger tg_stock_items
  after insert or update or delete on public.items
  for each row execute function public.mover_inventario_por_item();

-- ----------------------------------------------------- permisos -------------
-- Las sedes las ve todo el mundo (el ayudante tiene que poder elegir dónde
-- está parado), pero solo el dueño las crea o las cambia.

alter table public.sedes enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'sedes'
  loop
    execute format('drop policy %I on public.sedes', p.policyname);
  end loop;
end $$;

create policy sedes_ver on public.sedes
  for select to authenticated using (true);

create policy sedes_editar on public.sedes
  for all to authenticated
  using (public.es_dueno()) with check (public.es_dueno());

-- Cambios en vivo también para sedes.
do $$
begin
  begin
    alter publication supabase_realtime add table public.sedes;
  exception when duplicate_object then null;
  end;
end $$;

alter table public.sedes replica identity full;

-- ----------------------------------------------------- comprobación ---------

select s.nombre,
       count(i.*) filter (where i.sede_id = s.id) as filas_de_inventario,
       coalesce(sum(i.stock) filter (where i.sede_id = s.id), 0) as vasos
  from public.sedes s
  left join public.inventario i on i.sede_id = s.id
 where not s.deleted
 group by s.nombre
 order by s.nombre;
