-- ============================================================================
--  NOVA POS — el historial es solo del dueño
--
--  Pegá este archivo en Supabase → SQL Editor → Run.
--  Solo hace falta si ya corriste schema.sql antes de este cambio.
--  Se puede correr varias veces sin romper nada.
--
--  Qué cambia: el ayudante pasa a ver únicamente el turno en el que está
--  trabajando — lo de hoy, más cualquier cuenta que siga abierta aunque sea
--  de otro día, porque sin eso no podría cobrarle a quien quedó debiendo.
--  Lo de días anteriores, ya cerrado, para él deja de existir.
-- ============================================================================

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

-- Reemplazo de las políticas anteriores, que dejaban ver todo a cualquiera
-- que hubiera iniciado sesión.
do $$
declare t text; p record;
begin
  foreach t in array array['cuentas','items','pagos']
  loop
    for p in select policyname from pg_policies
             where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

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

-- Comprobación: debe listar 9 políticas (3 por tabla).
select tablename, policyname, cmd
  from pg_policies
 where schemaname = 'public'
   and tablename in ('cuentas', 'items', 'pagos')
 order by tablename, cmd;
