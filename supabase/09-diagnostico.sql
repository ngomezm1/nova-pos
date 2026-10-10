-- ============================================================================
--  NOVA POS — diagnóstico desde la app
--
--  Pegá este archivo en Supabase → SQL Editor → Run.
--  Se puede correr varias veces sin romper nada.
--
--  Para qué: cuando el servidor rechaza datos, había que entrar a Supabase y
--  hacerse pasar por el usuario para entender por qué. Esto deja que la app
--  pregunte directamente "¿quién soy para vos y qué me dejás hacer?", y lo
--  muestre en Ajustes → Revisar conexión.
-- ============================================================================

create or replace function public.mi_estado()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'uid',         auth.uid(),
    'rol_db',      current_user,
    'rol_app',     (select rol    from public.perfiles where id = auth.uid()),
    'nombre',      (select nombre from public.perfiles where id = auth.uid()),
    'activo',      (select activo from public.perfiles where id = auth.uid()),
    'habilitado',  public.habilitado(),
    'es_dueno',    public.es_dueno(),
    'dia_negocio', public.dia_negocio()
  );
$$;

grant execute on function public.mi_estado() to authenticated;

-- ----------------------------------------------------- comprobación --------
-- En el editor sale uid nulo y habilitado false, porque acá no hay sesión de
-- usuario. Lo que importa es que la función exista y responda.

select public.mi_estado() as asi_lo_ve_el_servidor;
