# NOVA POS — referencia técnica

Documento de contexto para retomar el proyecto en otra sesión. Describe cómo
está armado, **por qué** está armado así, y las trampas que ya costaron tiempo.

- **App en vivo:** https://ngomezm1.github.io/nova-pos/
- **Repo:** `ngomezm1/nova-pos` (público, rama `main`)
- **Servidor:** Supabase, proyecto "Laura Project" (`gtcodeclnylkabqfrahk`), plan free
- **Versión actual:** app `2.7` · caché del service worker `nova-pos-v29`

---

## 1. Qué es

Punto de venta para **NOVA — Granizados, Cócteles y Micheladas** (Medellín).
Negocio real, en producción, usado todas las noches por el dueño y una asesora.

Restricciones que decidieron el diseño:

- **Sin presupuesto.** Todo corre en planes gratuitos.
- **No hay mesas.** Las cuentas se identifican con un nombre escrito a mano.
- **Dos celulares** (iPhone), ambos en terreno, con señal inestable.
- **La asesora no puede ver inventario, precios ni historial.** Pedido explícito.
- El control de inventario es **sobre los vasos**, no sobre los sabores.

---

## 2. Arquitectura

**PWA de archivos estáticos.** Sin build, sin dependencias, sin framework. Son
archivos que el navegador abre directamente; GitHub Pages los sirve tal cual.

```
index.html          cáscara + arranque
guia.html           guía de instalación para mandar por WhatsApp
css/style.css       tema neón espacial (1200 líneas)
js/store.js         datos y reglas de negocio (1380 líneas)
js/cloud.js         sesión y sincronización con Supabase (690 líneas)
js/ui.js            todas las pantallas (2470 líneas)
sw.js               service worker
supabase/*.sql      esquema y migraciones, en orden
tools/guia-pdf.py   genera el PDF de instalación
```

**Local-first.** Todo se escribe primero en `localStorage` y se marca `_dirty`.
Un hilo de sincronización sube lo pendiente y baja lo nuevo. La app funciona sin
señal: en el local la hay a ratos.

**Tres globales**, cargadas en este orden por `index.html`:
`NOVA.store` → `NOVA.cloud` → `NOVA.ui`.

### Flujo de arranque

```
DOMContentLoaded
  └─ cloud.iniciar()            carga el SDK, recupera sesión
      ├─ requiereLogin()  → pantallaLogin()
      └─ arrancarApp()
           ├─ store.sembrar()   solo en modo local
           ├─ sin sede y hay varias → pantallaSede()
           └─ montarApp() → render()
```

`render()` repinta **todo** en cada cambio. El volumen de un turno de ventas es
chico y así nunca queda una pantalla desfasada del dato real.

### Sincronización

- `push()` sube las filas `_dirty`, **una tabla a la vez, en paralelo**. Si una
  falla, las demás siguen.
- Si el bloque de una tabla es rechazado por algo que no es la red, se reintenta
  **fila por fila** (`subirUnaPorUna`) y se informa cuál falla.
- `pull()` baja por marca de agua: `updated_at > nova.sync.<tabla>`.
- `latir()` avisa presencia y relee el propio perfil; si el dueño desactivó la
  cuenta, cierra sesión sola.
- Intervalo de 20 s + canal realtime de Supabase.

---

## 3. Modelo de datos

Siete tablas, mismo nombre en `localStorage` y en Postgres. Toda fila tiene
`id` (uuid), `updated_at` y `deleted`.

| Tabla | Para qué |
|---|---|
| `sedes` | locales; cada uno con su inventario |
| `productos` | catálogo y precios |
| `cuentas` | una por cliente que está pidiendo |
| `items` | líneas de consumo de una cuenta |
| `pagos` | cobros, totales o parciales |
| `inventario` | stock por sede |
| `movimientos` | historial de entradas, salidas, mermas, traslados |

Además `perfiles`, que **solo existe en el servidor** (usuarios, roles,
presencia).

### Conceptos que no se ven en los nombres

**Día de negocio (corta a las 5 am).** Lo que se vende a la 1 am pertenece a la
noche anterior. Está en `store.diaNegocio()` y en `public.dia_negocio()` — las
dos definiciones tienen que coincidir. La del servidor usa `America/Bogota`.

**Clave de inventario.** Cada línea de stock se identifica por `clave`:
- vasos → `icopor-16`, `plastico-unico` (ver `claveVaso(tipo, oz)`)
- insumos → `insumo-<uuid>`, **la misma en todas las sedes**

El vaso plástico es uno solo y **no lleva onzas** (`oz = null`). Por eso la
unicidad del inventario es `(sede_id, clave)` y no `(tipo, oz)`: en Postgres
varios `null` no chocan entre sí.

**Qué descuenta un producto.** `productos.consume` apunta a una clave de
inventario, y `consume_cant` dice cuántas unidades saca cada venta (2 en los
2x1). `vaso`/`oz` quedan por compatibilidad: `claveConsumo()` prefiere
`consume` y cae a `vaso+oz` si no está.

**Pagos parciales y división.** `pagos.cubre` es un jsonb
`[{item_id, cant}]`. Al dividir una cuenta, esas unidades quedan marcadas en
`items.pagadas` y ya no se pueden quitar.

**Nadie borra.** No hay política de `DELETE` en ninguna tabla. Las anulaciones
marcan `deleted = true` y queda el rastro.

---

## 4. Roles y permisos

Dos roles en `perfiles.rol`: `dueno` y `ayudante`.

| | Dueño | Ayudante |
|---|---|---|
| Vender, cobrar, dividir | ✅ | ✅ |
| Ver quién debe | ✅ | ✅ |
| Inventario | ✅ | 🚫 |
| Precios y productos | ✅ | 🚫 |
| Historial de días anteriores | ✅ | 🚫 |
| Anular una cuenta | ✅ | 🚫 |
| Administrar usuarios y sedes | ✅ | 🚫 |

**Dónde se aplica de verdad:** en el servidor, no en la app.

- `habilitado()` se cruza con **todas** las políticas. Desactivar a alguien le
  corta el acceso aunque tenga la sesión abierta.
- `es_dueno()` exige además `activo = true`.
- `inventario` y `movimientos`: políticas `using (es_dueno())`. Un ayudante que
  los consulte recibe cero filas.
- El descuento de vasos por venta lo hace un **trigger** en la base
  (`SECURITY DEFINER`), por eso el ayudante descuenta stock sin tener permiso
  sobre inventario.

Esconder un botón **no** es una regla. Cada restricción real tiene su
contraparte en SQL.

---

## 5. Las decisiones que más costaron

Esto es lo que no conviene redescubrir a los golpes.

### `guardar_filas()`: separar poder guardar de poder leer

**Síntoma:** `new row violates row-level security policy for table "cuentas"`
al cobrar una deuda vieja.

**Causa:** para modificar una fila existente, PostgreSQL necesita **leerla**.
La regla que esconde el historial le ocultaba al ayudante las cuentas cerradas
de otros días, así que podía cobrarlas pero no registrar el cobro.

**Solución:** `cuentas`, `items` y `pagos` se escriben por la función
`public.guardar_filas(p_tabla, p_filas)` (`SECURITY DEFINER`), que comprueba
`habilitado()` por sí misma. Leer y escribir dejaron de estar atados.

Las demás tablas siguen con upsert normal.

### Reconciliación de duplicados

Quien usa la app antes de conectar Supabase termina con dos juegos de
productos, sedes e inventario: los que sembró el celular y los que creó
`schema.sql`. Mismo nombre, distinto id → el servidor los rechaza para siempre.

`store.reconciliar()` corre al sincronizar: gana la fila del servidor y las
referencias se repuntan a ella. Conserva el stock contado en local si la fila
del servidor viene en cero.

### El día en curso no entra en los promedios

`tendencia()` deja fuera el día de hoy, que siempre está a medias, y compara
**bloques del mismo tamaño** (últimos N días contra los N anteriores).
Comparar contra el promedio histórico daría un número que casi no se mueve.

### Con una sola sede abierta no se pregunta nada

Mientras haya dos botones en pantalla hay forma de tocar el que no es, y una
noche registrada en el local equivocado se arregla a mano. Si queda una sola
sede activa: se entra directo y se esconde el botón "Cambiar".

---

## 6. Migraciones SQL

Se corren **en orden**, cada una en su propia query, en Supabase → SQL Editor.
Todas son idempotentes.

| Archivo | Qué agrega |
|---|---|
| `schema.sql` | tablas, RLS, trigger de descuento, catálogo inicial |
| `02-historial-solo-dueno.sql` | el ayudante ve solo su turno |
| `03-sedes.sql` | varias sedes, cada una con su inventario |
| `04-insumos.sql` | inventario de cualquier insumo, no solo vasos |
| `05-sesiones.sql` | presencia, activar/desactivar usuarios |
| `06-consumo.sql` | cada producto elige qué descuenta |
| `07-promos.sql` | una venta puede descontar más de una unidad (2x1) |
| `08-permiso-escritura.sql` | separa la regla de lectura de la de escritura |
| `09-diagnostico.sql` | `mi_estado()`, para que la app se autodiagnostique |
| `10-guardar-sin-leer.sql` | `guardar_filas()` |
| `11-anular-solo-dueno.sql` | solo el dueño anula cuentas |

### ⚠️ El editor de Supabase corre todo el script en UNA transacción

Un `rollback` al final de un archivo **deshace también los `create function`**
de arriba. Pasó: la prueba devolvía `{"guardadas":1}` y la función no quedaba
creada. **Ninguna migración debe tener `begin;` / `rollback;`.**

Para probar impersonando a un usuario, hacerlo en una query aparte:

```sql
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id::text from public.perfiles where rol = 'ayudante'),
                    'role', 'authenticated')::text, true);
set local role authenticated;
-- ... lo que se quiera probar ...
rollback;
```

Después de crear o cambiar una función: `notify pgrst, 'reload schema';` o
PostgREST sigue sin verla.

---

## 7. Convenciones

**Idioma:** todo en español — identificadores, comentarios, textos, mensajes de
commit. Voseo (paisa), que es como habla el dueño.

**JavaScript:** ES5 (`var`, `function`), sin módulos. Cada archivo es un IIFE
que cuelga de `window.NOVA`. Sin dependencias salvo el SDK de Supabase, que se
carga por CDN solo si hay servidor configurado.

**Comentarios:** explican *por qué*, nunca *qué*. Si un comentario se puede
deducir leyendo la línea de abajo, sobra.

**Nombres de función:** verbo en infinitivo (`registrarPago`, `trasladar`).
Los booleanos preguntan (`hay2x1Activo`, `hayQueElegirSede`).

**CSS:** variables en `:root`, clases tipo BEM suelto (`.cuenta__nombre`).
Pensado para pulgar: nada táctil por debajo de 44 px.

**Mensajes de error al usuario:** dicen qué pasó y qué hacer. Nunca "Error".

---

## 8. Publicar un cambio

```bash
git add -A && git commit -m "..." && git push origin main
```

GitHub Pages republica en 1–2 minutos. Además, **en cada cambio de JS/CSS**:

1. Subir `NOVA.VERSION` en `js/ui.js`
2. Subir `var CACHE` en `sw.js`

Sin eso, los celulares pueden quedarse con la versión vieja y no hay forma de
saber cuál están corriendo. En los teléfonos: **Ajustes → La app → Buscar
actualización**.

El service worker pide el código propio **a la red primero** (caché como
respaldo), justamente para que una corrección llegue en la primera apertura.

---

## 9. Trampas conocidas

**iOS solo instala desde Safari.** El recorrido real: 3 puntos abajo a la
derecha → Compartir → Ver más → "Agregar a inicio". Desde Chrome no existe.

**Cerrar sesión borra el celular.** Si hay ventas sin subir, se pierden. La app
avisa antes y la expulsión por desactivación conserva lo pendiente.

**El plan free de Supabase no hace respaldos automáticos**, y el proyecto se
pausa tras una semana sin actividad. Rutina mensual recomendada:
*Ajustes → Historial → Descargar TODO en Excel*.

**Los parches por script y los acentos.** Varios archivos guardan los acentos
como escapes de JavaScript (`á`) y otros como caracteres. Un script que
busque texto literal tiene que reintentar con la forma escapada.

**Heredocs grandes en bash se rompen.** Para escribir archivos largos, usar la
herramienta de escritura o un script en un archivo aparte, no `cat <<EOF`.

---

## 10. Diagnóstico cuando algo falla

En el celular afectado: **Ajustes → Revisar conexión**. Muestra cómo lo ve el
servidor (si reconoce la sesión, el rol, si está habilitado, qué día considera
hoy), qué filas fueron rechazadas y con qué motivo, y el estado de cada tabla.

Eso distingue de un vistazo una sesión vencida, de un acceso desactivado, de un
dato malo en una fila.

**Lección que costó varias vueltas:** reproducir el fallo en el servidor
impersonando al usuario toma 30 segundos y vale más que cualquier hipótesis.
Medir antes de corregir.
