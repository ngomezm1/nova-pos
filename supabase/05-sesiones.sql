-- ============================================================================
--  NOVA POS — control de accesos
--
--  Pegá este archivo en Supabase → SQL Editor → Run.
--  Se puede correr varias veces sin romper nada.
--
--  Qué agrega: el dueño ve quién está conectado y puede desactivar a
--  cualquier usuario. Un usuario desactivado deja de poder leer los datos del
--  negocio de inmediato — no es que la app se los esconda, es que la base de
--  datos se los niega.
-- ============================================================================

alter table public.perfiles add column if not exists activo      boolean not null default true;
alter table public.perfiles add column if not exists visto_en    timestamptz;
alter table public.perfiles add column if not exists dispositivo text;

-- ------------------------------------------------- quién está habilitado ---

/* Un usuario desactivado no es "sin permisos": es como si no existiera. Esta
 * función se cruza con TODAS las políticas, así que apagar el interruptor
 * corta el acceso aunque la persona tenga la sesión abierta en su celular.
 */
create or replace function public.habilitado()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select activo from public.perfiles where id = auth.uid()), false);
$$;

-- Ser dueño ahora exige además estar activo.
create or replace function public.es_dueno()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select rol = 'dueno' and activo from public.perfiles where id = auth.uid()),
    false
  );
$$;

-- ------------------------------------------------------------ presencia ---

/* El celular avisa que sigue vivo cada vez que sincroniza. Va como función y
 * no como UPDATE directo porque dejar que cada quien edite su propio perfil
 * permitiría que un ayudante se ascendiera a dueño.
 */
create or replace function public.tocar_presencia(p_dispositivo text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.perfiles
     set visto_en = now(),
         dispositivo = coalesce(nullif(p_dispositivo, ''), dispositivo)
   where id = auth.uid();
end;
$$;

grant execute on function public.tocar_presencia(text) to authenticated;

-- ===================================================== permisos (RLS) ======
-- Se rehacen todas las políticas para exigir habilitado().

do $$
declare t text; p record;
begin
  foreach t in array array['perfiles','productos','sedes','cuentas','items',
                           'pagos','inventario','movimientos']
  loop
    for p in select policyname from pg_policies
             where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- perfiles: cada quien se ve a sí mismo SIEMPRE, incluso desactivado. Esa es
-- la señal que usa su app para darse cuenta y cerrarse sola.
create policy perfil_propio on public.perfiles
  for select to authenticated
  using (id = auth.uid() or public.es_dueno());

create policy perfil_admin on public.perfiles
  for update to authenticated
  using (public.es_dueno()) with check (public.es_dueno());

-- sedes: todos los habilitados las ven; solo el dueño las cambia.
create policy sedes_ver on public.sedes
  for select to authenticated using (public.habilitado());

create policy sedes_editar on public.sedes
  for all to authenticated
  using (public.es_dueno()) with check (public.es_dueno());

-- productos: todos los habilitados ven precios; solo el dueño los cambia.
create policy productos_ver on public.productos
  for select to authenticated using (public.habilitado());

create policy productos_editar on public.productos
  for all to authenticated
  using (public.es_dueno()) with check (public.es_dueno());

-- cuentas / items / pagos: el turno del día, como ya estaba, pero solo si
-- el usuario sigue habilitado.
create policy cuentas_ver on public.cuentas
  for select to authenticated
  using (public.habilitado()
         and (public.es_dueno() or fecha >= public.dia_negocio() or estado = 'abierta'));

create policy cuentas_crear on public.cuentas
  for insert to authenticated with check (public.habilitado());

create policy cuentas_editar on public.cuentas
  for update to authenticated
  using (public.habilitado()
         and (public.es_dueno() or fecha >= public.dia_negocio() or estado = 'abierta'))
  with check (public.habilitado());

do $$
declare t text;
begin
  foreach t in array array['items','pagos']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated
       using (public.habilitado()
              and (public.es_dueno() or fecha >= public.dia_negocio()
                   or public.cuenta_del_turno(cuenta_id)))',
      t || '_ver', t);

    execute format(
      'create policy %I on public.%I for insert to authenticated
       with check (public.habilitado())',
      t || '_crear', t);

    execute format(
      'create policy %I on public.%I for update to authenticated
       using (public.habilitado()
              and (public.es_dueno() or fecha >= public.dia_negocio()
                   or public.cuenta_del_turno(cuenta_id)))
       with check (public.habilitado())',
      t || '_editar', t);
  end loop;
end $$;

-- inventario y movimientos: exclusivos del dueño, que ya exige estar activo.
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

-- Nadie borra con DELETE: al no existir política de delete, queda prohibido.

-- ================================================== cambios en vivo ========
-- Para que el dueño vea la presencia moverse sin recargar, y para que el
-- usuario desactivado se entere en el acto.

do $$
begin
  begin
    alter publication supabase_realtime add table public.perfiles;
  exception when duplicate_object then null;
  end;
end $$;

alter table public.perfiles replica identity full;

-- ----------------------------------------------------- comprobación --------

select nombre,
       email,
       rol,
       activo,
       case
         when visto_en is null then 'nunca'
         when visto_en > now() - interval '2 minutes' then 'conectado ahora'
         else 'hace ' || age(now(), visto_en)::text
       end as presencia,
       coalesce(dispositivo, '—') as dispositivo
  from public.perfiles
 order by activo desc, visto_en desc nulls last;
