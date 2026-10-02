/* NOVA POS — sesión y sincronización con Supabase.
 *
 * Cómo funcionan los permisos:
 *  - El dueño y el ayudante entran con usuarios distintos (Supabase Auth).
 *  - El ayudante NO descarga inventario ni movimientos, y aunque modificara esta app,
 *    la base de datos le niega esas tablas (RLS). Ver supabase/schema.sql.
 *  - El descuento de vasos por venta lo hace un trigger en la base de datos,
 *    por eso el ayudante puede vender sin tener permiso sobre el inventario.
 */
(function (global) {
  'use strict';

  var CFG_KEY = 'nova.cfg';
  var SYNC_KEY = 'nova.sync.';
  // Sin fijar parche: Supabase estrenó un formato de llaves (sb_publishable_…)
  // y conviene tomar siempre la última v2, que lo soporta.
  var SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';

  var TABLAS_TODAS = ['sedes', 'productos', 'cuentas', 'items', 'pagos', 'inventario', 'movimientos'];
  // El ayudante necesita las sedes para poder elegir dónde está parado.
  var TABLAS_AYUDANTE = ['sedes', 'productos', 'cuentas', 'items', 'pagos'];

  var sb = null;            // cliente supabase
  var perfil = null;        // { id, nombre, rol }
  var usuario = null;       // auth user
  var estado = 'local';     // local | conectando | conectado | error | offline
  var ultimoError = '';
  var pushTimer = null;
  var pullTimer = null;
  var canal = null;
  var oyentes = [];
  // Subida y bajada se registran por separado: que la bajada funcione no
  // significa que la subida tambien, y son problemas distintos.
  var fallasPush = {};
  var fallasPull = {};
  var reintentando = false; // evita que la reconciliacion se llame en bucle
  var seguidas = 0;         // fallos consecutivos de subida
  var pausado = false;      // deja de reintentar solo tras varios fallos
  var ERR_KEY = 'nova.ultimoError';

  /* ---------- configuración ---------- */

  /* Un nombre aproximado del aparato. No identifica a nadie: solo sirve para
   * que el dueño distinga "iPhone" de "Windows" al mirar quién está conectado.
   */
  function nombreDispositivo() {
    var ua = navigator.userAgent || '';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac OS X/i.test(ua)) return 'Mac';
    return 'Otro';
  }

  function cfg() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch (e) { return null; }
  }

  function guardarCfg(url, anonKey) {
    url = (url || '').trim().replace(/\/+$/, '');
    anonKey = (anonKey || '').trim();

    if (!url || !anonKey) throw new Error('Faltan la URL y la clave pública del proyecto.');
    if (!/^https:\/\/.+\.supabase\.co$/.test(url)) {
      throw new Error('La URL debe verse así: https://xxxxxxxx.supabase.co');
    }

    // Pegar una llave privada acá la publicaría en el celular y anularía de un
    // golpe todos los permisos: quien la tuviera podría leer el inventario.
    if (/^sb_secret_/.test(anonKey) || /service_role/.test(anonKey)) {
      throw new Error('Esa es una clave PRIVADA (secret / service_role). ' +
                      'Usá la publishable o la anon public.');
    }
    if (!/^sb_publishable_/.test(anonKey) && !/^eyJ/.test(anonKey)) {
      throw new Error('Esa clave no parece la correcta. Debe empezar con ' +
                      '"sb_publishable_" o con "eyJ".');
    }

    localStorage.setItem(CFG_KEY, JSON.stringify({ url: url, anonKey: anonKey }));
  }

  function borrarCfg() {
    localStorage.removeItem(CFG_KEY);
    TABLAS_TODAS.forEach(function (t) { localStorage.removeItem(SYNC_KEY + t); });
  }

  function configurado() { return !!cfg(); }
  function activo() { return !!(sb && usuario && perfil); }

  function tablas() {
    return esDueno() ? TABLAS_TODAS : TABLAS_AYUDANTE;
  }

  /* ---------- eventos ---------- */

  function avisar() {
    oyentes.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } });
  }

  function setEstado(e, err) {
    estado = e;
    ultimoError = err || '';
    avisar();
  }

  /* ---------- carga del SDK ---------- */

  function cargarSDK() {
    if (global.supabase) return Promise.resolve(global.supabase);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SDK;
      s.onload = function () {
        global.supabase ? resolve(global.supabase)
                        : reject(new Error('El SDK de Supabase cargó incompleto.'));
      };
      s.onerror = function () {
        reject(new Error('No se pudo descargar Supabase. Revisá la conexión a internet.'));
      };
      document.head.appendChild(s);
    });
  }

  /* ---------- arranque ---------- */

  function iniciar() {
    var c = cfg();
    if (!c) { setEstado('local'); return Promise.resolve(false); }
    setEstado('conectando');
    return cargarSDK()
      .then(function (lib) {
        sb = lib.createClient(c.url, c.anonKey, {
          auth: { persistSession: true, autoRefreshToken: true, storageKey: 'nova.auth' }
        });
        return sb.auth.getSession();
      })
      .then(function (r) {
        var ses = r && r.data ? r.data.session : null;
        if (!ses) { setEstado('local'); return false; }
        return tomarSesion(ses.user);
      })
      .catch(function (e) {
        setEstado('error', e.message);
        return false;
      });
  }

  function tomarSesion(user) {
    usuario = user;
    return sb.from('perfiles').select('*').eq('id', user.id).single()
      .then(function (r) {
        if (r.error) throw new Error('No se pudo leer tu perfil: ' + r.error.message);
        perfil = r.data;
        setEstado('conectado');
        arrancarSync();
        return true;
      })
      .catch(function (e) {
        usuario = null; perfil = null;
        setEstado('error', e.message);
        return false;
      });
  }

  /* ---------- autenticación ---------- */

  function entrar(email, password) {
    if (!sb) return Promise.reject(new Error('Primero conectá la app con Supabase en Ajustes.'));
    return sb.auth.signInWithPassword({ email: (email || '').trim(), password: password })
      .then(function (r) {
        if (r.error) {
          var m = r.error.message || '';
          if (/invalid login/i.test(m)) throw new Error('Correo o contraseña incorrectos.');
          if (/email not confirmed/i.test(m)) throw new Error('Ese correo todavía no está confirmado.');
          throw new Error(m);
        }
        return tomarSesion(r.data.user);
      });
  }

  function salir(limpiarDatos) {
    var p = sb ? sb.auth.signOut() : Promise.resolve();
    return p.then(function () {
      pararSync();
      usuario = null; perfil = null;
      // En el celular del ayudante no debe quedar nada del negocio.
      if (limpiarDatos !== false) {
        NOVA.store.limpiarTodo();
        tablas().forEach(function (t) { localStorage.removeItem(SYNC_KEY + t); });
        TABLAS_TODAS.forEach(function (t) { localStorage.removeItem(SYNC_KEY + t); });
      }
      setEstado('local');
    });
  }

  function cambiarPassword(nueva) {
    if (!sb || !usuario) return Promise.reject(new Error('No hay sesión abierta.'));
    return sb.auth.updateUser({ password: nueva }).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return true;
    });
  }

  /* ---------- usuarios (solo dueño) ---------- */

  function listarPerfiles() {
    if (!sb) return Promise.resolve([]);
    return sb.from('perfiles').select('*').order('creado_en')
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data || [];
      });
  }

  function cambiarRol(id, rol) {
    if (!sb) return Promise.reject(new Error('Sin conexión.'));
    if (id === (usuario && usuario.id) && rol !== 'dueno') {
      return Promise.reject(new Error('No podés quitarte a vos mismo el rol de dueño.'));
    }
    return sb.from('perfiles').update({ rol: rol }).eq('id', id).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return true;
    });
  }

  function cambiarActivo(id, activo_) {
    if (!sb) return Promise.reject(new Error('Sin conexión.'));
    if (id === (usuario && usuario.id)) {
      return Promise.reject(new Error('No podés desactivarte a vos mismo.'));
    }
    return sb.from('perfiles').update({ activo: !!activo_ }).eq('id', id).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return true;
    });
  }

  /* Cierra la sesión de este usuario en TODOS sus aparatos. Es lo que hay que
   * usar al entregar el proyecto: aunque alguien tuviera la contraseña vieja
   * guardada en un teléfono, esa sesión deja de servir.
   */
  function cerrarTodasMisSesiones() {
    if (!sb) return Promise.reject(new Error('Sin conexión.'));
    return sb.auth.signOut({ scope: 'global' }).then(function (r) {
      if (r && r.error) throw new Error(r.error.message);
      pararSync();
      usuario = null; perfil = null;
      NOVA.store.limpiarTodo();
      setEstado('local');
      return true;
    });
  }

  function renombrarPerfil(id, nombre) {
    return sb.from('perfiles').update({ nombre: nombre }).eq('id', id).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      if (perfil && perfil.id === id) perfil.nombre = nombre;
      return true;
    });
  }

  /* ---------- sincronización ---------- */

  /* Un fallo de red y un rechazo del servidor se arreglan de formas opuestas:
   * uno se espera, el otro hay que corregirlo. Mostrarlos igual manda a buscar
   * el problema donde no esta.
   */
  function esFalloDeRed(e) {
    var m = String((e && e.message) || e || '');
    return /failed to fetch|networkerror|load failed|network request failed|ERR_INTERNET/i.test(m)
           || !navigator.onLine;
  }

  /* El ultimo error queda guardado en el celular. Si solo viviera en memoria,
   * el siguiente intento lo borraria y no habria forma de leerlo.
   */
  function guardarUltimoError(detalle) {
    try {
      localStorage.setItem(ERR_KEY, JSON.stringify({
        cuando: new Date().toISOString(), detalle: detalle
      }));
    } catch (e) { /* sin espacio: el error en pantalla alcanza */ }
  }

  // Lee el ultimo error guardado en el celular. Se llama distinto que la
  // variable `ultimoError`, que guarda el detalle del estado en memoria.
  function errorGuardado() {
    try { return JSON.parse(localStorage.getItem(ERR_KEY) || 'null'); }
    catch (e) { return null; }
  }

  function olvidarUltimoError() {
    localStorage.removeItem(ERR_KEY);
  }

  function resumirFallas() {
    var rotas = {};
    Object.keys(fallasPush).forEach(function (t) { rotas['subir ' + t] = fallasPush[t]; });
    Object.keys(fallasPull).forEach(function (t) { rotas['bajar ' + t] = fallasPull[t]; });

    var claves = Object.keys(rotas);
    if (!claves.length) {
      seguidas = 0;
      pausado = false;
      olvidarUltimoError();
      setEstado('conectado');
      return;
    }

    var deRed = claves.every(function (k) { return rotas[k].red; });
    var detalle = claves.map(function (k) { return k + ': ' + rotas[k].motivo; }).join(' · ');

    if (!deRed) guardarUltimoError(detalle);

    if (pausado) {
      setEstado('error', detalle + ' — reintentos en pausa');
    } else {
      setEstado(deRed ? 'offline' : 'error', detalle);
    }
  }

  function limpiarFila(r) {
    var out = {};
    Object.keys(r).forEach(function (k) { if (k !== '_dirty') out[k] = r[k]; });
    return out;
  }

  /* Cada tabla se sube por separado. Antes iban encadenadas, asi que una sola
   * tabla con problemas dejaba sin subir a todas las demas: las ventas se
   * quedaban en el celular por culpa de, por ejemplo, una tabla que todavia
   * no existia en el servidor.
   */
  function push(forzado) {
    if (!activo()) return Promise.resolve();
    if (pausado && !forzado) return Promise.resolve();

    var pendientes = tablas().filter(function (t) { return NOVA.store.sucios(t).length; });
    if (!pendientes.length) { fallasPush = {}; resumirFallas(); return Promise.resolve(); }

    return Promise.all(pendientes.map(function (t) {
      var filas = NOVA.store.sucios(t);
      return sb.from(t).upsert(filas.map(limpiarFila), { onConflict: 'id' })
        .then(function (r) {
          if (r.error) throw new Error(r.error.message);
          NOVA.store.limpiarSucios(t, filas.map(function (f) { return f.id; }));
          delete fallasPush[t];
        })
        .catch(function (e) {
          fallasPush[t] = { motivo: (e && e.message) || 'error', red: esFalloDeRed(e) };
        });
    })).then(function () {
      // Un nombre repetido no se arregla reintentando: hay una copia local de
      // algo que el servidor ya tiene. Se reconcilia y se reintenta una vez.
      var duplicados = Object.keys(fallasPush).some(function (t) {
        return /duplicate key|already exists/i.test(fallasPush[t].motivo);
      });
      if (duplicados && !reintentando && NOVA.store.reconciliar()) {
        reintentando = true;
        fallasPush = {};
        return push().then(function () { reintentando = false; });
      }

      // Si el servidor sigue rechazando, insistir cada 20 segundos solo gasta
      // bateria y hace parpadear el error. Mejor parar y decirlo.
      var falloReal = Object.keys(fallasPush).some(function (t) { return !fallasPush[t].red; });
      seguidas = falloReal ? seguidas + 1 : 0;
      if (seguidas >= 3) pausado = true;

      resumirFallas();
      avisar();
    });
  }

  function pull() {
    if (!activo()) return Promise.resolve();

    return Promise.all(tablas().map(function (t) {
      var desde = localStorage.getItem(SYNC_KEY + t) || '1970-01-01T00:00:00.000Z';
      return sb.from(t).select('*').gt('updated_at', desde).order('updated_at')
        .then(function (r) {
          if (r.error) throw new Error(r.error.message);
          var filas = r.data || [];
          if (filas.length) {
            NOVA.store.aplicarRemotos(t, filas);
            localStorage.setItem(SYNC_KEY + t, filas[filas.length - 1].updated_at);
          }
          delete fallasPull[t];
        })
        .catch(function (e) {
          fallasPull[t] = { motivo: (e && e.message) || 'error', red: esFalloDeRed(e) };
        });
    })).then(function () {
      // El ayudante no guarda historial: lo de días pasados se borra de su
      // celular apenas termina de bajar lo nuevo.
      if (!esDueno()) NOVA.store.purgarHistorial();
      resumirFallas();
    });
  }

  /* Reparacion manual: reconcilia, reintenta aunque este en pausa y devuelve
   * el resultado para mostrarlo quieto en pantalla, no en un badge que cambia.
   */
  function contarPendientes() {
    return TABLAS_TODAS.reduce(function (n, t) {
      return n + (NOVA.store.sucios(t) || []).length;
    }, 0);
  }

  function repararYReintentar() {
    pausado = false;
    seguidas = 0;
    fallasPush = {};
    fallasPull = {};

    var antes = contarPendientes();
    var limpiadas = NOVA.store.reconciliar();

    return pull()
      .then(function () { return push(true); })
      .then(latir)
      .then(function () {
        var rotas = Object.keys(fallasPush).concat(Object.keys(fallasPull));
        var despues = contarPendientes();
        return {
          limpiadas: limpiadas,
          subidas: Math.max(0, antes - despues),
          habia: antes,
          quedan: despues,
          ok: rotas.length === 0,
          detalle: rotas.length ? ((errorGuardado() || {}).detalle || ultimoError) : ''
        };
      })
      .catch(function (e) {
        return { ok: false, detalle: (e && e.message) || 'Error inesperado', limpiadas: 0 };
      });
  }

  /* Revisa tabla por tabla y devuelve un diagnostico legible. Sin esto, un
   * "no sincroniza" obliga a adivinar cual de siete tablas es la que falla.
   */
  function diagnosticar() {
    if (!sb) return Promise.resolve([{ tabla: '-', ok: false, motivo: 'Falta conectar el servidor.' }]);
    if (!usuario) return Promise.resolve([{ tabla: '-', ok: false, motivo: 'No hay sesión iniciada.' }]);

    return Promise.all(TABLAS_TODAS.map(function (t) {
      return sb.from(t).select('id', { count: 'exact', head: true })
        .then(function (r) {
          if (r.error) return { tabla: t, ok: false, motivo: r.error.message };
          return { tabla: t, ok: true, motivo: (r.count || 0) + ' filas' };
        })
        .catch(function (e) {
          return { tabla: t, ok: false, motivo: (e && e.message) || 'error' };
        });
    }));
  }

  /* Avisa que este celular sigue vivo y, de paso, relee el propio perfil. Si
   * el dueño desactivó esta cuenta, la sesión se cierra acá mismo en vez de
   * seguir mostrando datos que el servidor ya no entrega.
   */
  function latir() {
    if (!activo()) return Promise.resolve();

    return sb.rpc('tocar_presencia', { p_dispositivo: nombreDispositivo() })
      .then(function () {
        return sb.from('perfiles').select('*').eq('id', usuario.id).single();
      })
      .then(function (r) {
        if (r.error || !r.data) return;
        perfil = r.data;
        if (perfil.activo === false) return expulsar();
      })
      .catch(function () { /* sin señal: el proximo intento lo resuelve */ });
  }

  /* El dueño corto el acceso: se cierra sesion y se limpia el celular. Dejar
   * los datos ahi seria justo lo que se quiso evitar al desactivar.
   */
  function expulsar() {
    return salir(true).then(function () {
      try { localStorage.setItem('nova.expulsado', '1'); } catch (e) {}
      location.reload();
    });
  }

  function sincronizar() {
    return push().then(pull).then(latir);
  }

  function agendarPush() {
    if (!activo()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { push(); }, 700);
  }

  function arrancarSync() {
    // Primero bajar lo del servidor y recien despues subir: asi la
    // reconciliacion sabe cuales filas son las buenas.
    pull().then(function () {
      NOVA.store.reconciliar();
      return push();
    });
    clearInterval(pullTimer);
    // Red de seguridad por si el canal en vivo se cae.
    pullTimer = setInterval(function () { if (navigator.onLine) sincronizar(); }, 20000);

    if (canal) { try { sb.removeChannel(canal); } catch (e) {} }
    canal = sb.channel('nova-cambios');
    tablas().forEach(function (t) {
      canal.on('postgres_changes', { event: '*', schema: 'public', table: t }, function (msg) {
        if (msg.new && msg.new.id) {
          NOVA.store.aplicarRemotos(t, [msg.new]);
          var prev = localStorage.getItem(SYNC_KEY + t) || '';
          if ((msg.new.updated_at || '') > prev) {
            localStorage.setItem(SYNC_KEY + t, msg.new.updated_at);
          }
        }
      });
    });
    canal.subscribe();

    global.addEventListener('online', sincronizar);
  }

  function pararSync() {
    clearInterval(pullTimer);
    clearTimeout(pushTimer);
    if (canal && sb) { try { sb.removeChannel(canal); } catch (e) {} }
    canal = null;
  }

  /* ---------- rol ---------- */

  function esDueno() {
    if (!configurado()) return true;   // modo local: el único que usa la app es el dueño
    return !!(perfil && perfil.rol === 'dueno');
  }

  function nombre() {
    if (perfil && perfil.nombre) return perfil.nombre;
    if (usuario && usuario.email) return usuario.email.split('@')[0];
    return 'Dueño';
  }

  /* ---------- API pública ---------- */

  global.NOVA = global.NOVA || {};

  global.NOVA.cloud = {
    iniciar: iniciar, cfg: cfg, guardarCfg: guardarCfg, borrarCfg: borrarCfg,
    configurado: configurado, activo: activo,
    entrar: entrar, salir: salir, cambiarPassword: cambiarPassword,
    listarPerfiles: listarPerfiles, cambiarRol: cambiarRol, renombrarPerfil: renombrarPerfil,
    cambiarActivo: cambiarActivo, cerrarTodasMisSesiones: cerrarTodasMisSesiones,
    latir: latir,
    sincronizar: sincronizar, agendarPush: agendarPush, diagnosticar: diagnosticar,
    repararYReintentar: repararYReintentar, contarPendientes: contarPendientes,
    ultimoError: errorGuardado, olvidarUltimoError: olvidarUltimoError,
    pausado: function () { return pausado; },
    estado: function () { return estado; },
    error: function () { return ultimoError; },
    alCambiar: function (fn) { oyentes.push(fn); },
    cliente: function () { return sb; }
  };

  global.NOVA.sesion = {
    esDueno: esDueno,
    nombre: nombre,
    usuario: function () { return usuario; },
    perfil: function () { return perfil; },
    // Con Supabase configurado hay que iniciar sesión sí o sí.
    requiereLogin: function () { return configurado() && !activo(); }
  };
})(window);
