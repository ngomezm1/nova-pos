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

  /* ---------- configuración ---------- */

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

  function renombrarPerfil(id, nombre) {
    return sb.from('perfiles').update({ nombre: nombre }).eq('id', id).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      if (perfil && perfil.id === id) perfil.nombre = nombre;
      return true;
    });
  }

  /* ---------- sincronización ---------- */

  function limpiarFila(r) {
    var out = {};
    Object.keys(r).forEach(function (k) { if (k !== '_dirty') out[k] = r[k]; });
    return out;
  }

  function push() {
    if (!activo()) return Promise.resolve();
    var pendientes = tablas().filter(function (t) { return NOVA.store.sucios(t).length; });
    if (!pendientes.length) return Promise.resolve();

    return pendientes.reduce(function (cadena, t) {
      return cadena.then(function () {
        var filas = NOVA.store.sucios(t);
        if (!filas.length) return;
        return sb.from(t).upsert(filas.map(limpiarFila), { onConflict: 'id' })
          .then(function (r) {
            if (r.error) throw new Error(t + ': ' + r.error.message);
            NOVA.store.limpiarSucios(t, filas.map(function (f) { return f.id; }));
          });
      });
    }, Promise.resolve())
      .then(function () { if (estado !== 'conectado') setEstado('conectado'); avisar(); })
      .catch(function (e) { setEstado('offline', e.message); });
  }

  function pull() {
    if (!activo()) return Promise.resolve();
    return tablas().reduce(function (cadena, t) {
      return cadena.then(function () {
        var desde = localStorage.getItem(SYNC_KEY + t) || '1970-01-01T00:00:00.000Z';
        return sb.from(t).select('*').gt('updated_at', desde).order('updated_at')
          .then(function (r) {
            if (r.error) throw new Error(t + ': ' + r.error.message);
            var filas = r.data || [];
            if (filas.length) {
              NOVA.store.aplicarRemotos(t, filas);
              localStorage.setItem(SYNC_KEY + t, filas[filas.length - 1].updated_at);
            }
          });
      });
    }, Promise.resolve())
      .then(function () {
        // El ayudante no guarda historial: lo de días pasados se borra de su
        // celular apenas termina de bajar lo nuevo.
        if (!esDueno()) NOVA.store.purgarHistorial();
        if (estado !== 'conectado') setEstado('conectado');
      })
      .catch(function (e) { setEstado('offline', e.message); });
  }

  function sincronizar() {
    return push().then(pull);
  }

  function agendarPush() {
    if (!activo()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { push(); }, 700);
  }

  function arrancarSync() {
    sincronizar();
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
    sincronizar: sincronizar, agendarPush: agendarPush,
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
