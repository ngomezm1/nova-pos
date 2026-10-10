-- ============================================================================
--  NOVA POS — corregir el permiso de escritura del ayudante
--
--  Pegá este archivo en Supabase → SQL Editor → Run.
--  Se puede correr varias veces sin romper nada.
--
--  QUÉ ARREGLA
--  El 02 y el 05 limitaron al ayudante a ver solo su turno. La misma
--  condición quedó aplicada al permiso de ESCRIBIR, y ahí se contradice con
--  algo que sí queremos: el ayudante ve las cuentas que siguen abiertas de
--  otros días, para poder cobrarle a quien quedó debiendo. Pero al cobrarlas
--  la cuenta pasa a 'cerrada' y deja de cumplir la condición, así que el
--  servidor le rechaza guardar el cobro:
--    new row violates row-level security policy for table "cuentas"
--  Como todas las filas viajan en un solo bloque, esa fila bloquea también
--  las ventas de hoy. Lo mismo pasa con una venta vieja que quedó sin subir.
--
--  Esconder el historial es una regla de LECTURA. Aplicarla a la escritura
--  solo logra perder ventas, que es lo contrario de lo que se quería.
--
--  Lo que NO cambia: el ayudante sigue sin poder leer el historial, sin ver
--  inventario y sin tocar precios. Y nadie puede borrar nada.
-- ============================================================================

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

-- LECTURA: acá sí vive la regla del historial. El dueño ve todo; el ayudante
-- ve su turno y las cuentas que sigan abiertas, para poder cobrarlas.
create policy cuentas_ver on public.cuentas
  for select to authenticated
  using (public.habilitado()
         and (public.es_dueno() or fecha >= public.dia_negocio() or estado = 'abierta'));

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
  end loop;
end $$;

-- ESCRITURA: alcanza con estar habilitado. Un ayudante solo puede modificar
-- filas cuyo id conoce, y solo conoce las que su app le dejó ver o las que él
-- mismo creó. La privacidad del historial ya la garantiza la lectura.
do $$
declare t text;
begin
  foreach t in array array['cuentas','items','pagos']
  loop
    execute format(
      'create policy %I on public.%I for insert to authenticated
       with check (public.habilitado())',
      t || '_crear', t);

    execute format(
      'create policy %I on public.%I for update to authenticated
       using (public.habilitado()) with check (public.habilitado())',
      t || '_editar', t);
  end loop;
end $$;

-- Sin política de delete: borrar sigue prohibido para todos. Las anulaciones
-- marcan deleted y dejan rastro.

-- ----------------------------------------------------- comprobación --------
-- Deben salir 9 filas: por cada tabla un SELECT, un INSERT y un UPDATE.

select tablename, cmd, policyname
  from pg_policies
 where schemaname = 'public'
   and tablename in ('cuentas', 'items', 'pagos')
 order by tablename, cmd;
