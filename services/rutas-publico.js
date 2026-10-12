'use strict';

// ══ RUTAS PÚBLICAS: catálogo de cursos, encuesta de la portada y preguntas sin respuesta del chatbot ══
// server.js llama a montarRutasPublico(app, deps). Las reglas puras están en services/encuesta.js.
//
//   GET  /api/cursos/demo                     público   catálogo sin videos, urls ni preguntas
//   POST /api/encuesta                        público   copia parcial o completa de la encuesta
//   POST /api/chatbot/sin-respuesta           público   pregunta que la guía no supo contestar
//   GET  /api/admin/encuesta                  admin     respuestas de la encuesta (más recientes primero)
//   GET  /api/admin/chatbot/sin-respuesta     admin     preguntas sin respuesta, por veces
//
// Seguridad:
//  - Las colecciones encuestasProspectos y chatbotSinRespuesta las escribe SOLO este servidor (Admin SDK);
//    las reglas de Firestore niegan toda escritura del navegador y solo dejan leer al administrador.
//  - No se guarda la IP de nadie: solo se usa en memoria para limitar solicitudes.
//  - Cada ruta pública limita por IP y, además, tiene un tope global por ventana para que rotar
//    cabeceras X-Forwarded-For no permita llenar Firestore.

const crypto = require('crypto');
const express = require('express');
const { permitirSolicitud } = require('./rutas-club');
const referidos = require('./referidos');
const enc = require('./encuesta');

const VENTANA_MS = 10 * 60 * 1000;
const ENCUESTAS_POR_IP = 20;
const SIN_RESPUESTA_POR_IP = 30;
const CATALOGO_POR_IP = 300;
const ENCUESTAS_GLOBAL = 600;
const SIN_RESPUESTA_GLOBAL = 1200;
const ADMIN_POR_MINUTO = 30;
const LIMITE_CUERPO = '8kb';

const CATALOGO_TTL_MS = 5 * 60 * 1000;          // vigencia del caché del catálogo
const CATALOGO_REINTENTO_MS = 10 * 1000;        // mínimo entre lecturas si Firestore falla
const CACHE_CATALOGO = 'public, max-age=300';

const ENCUESTA_LIMITE_DEFECTO = 1000;
const ENCUESTA_LIMITE_MAXIMO = 2000;
const SIN_RESPUESTA_LIMITE_DEFECTO = 200;
const SIN_RESPUESTA_LIMITE_MAXIMO = 1000;

function montarRutasPublico(app, deps) {
  const { db, admin, autenticarAdmin, errorHttp } = deps;
  const esVideoGratisFijo = typeof deps.esVideoGratisFijo === 'function' ? deps.esVideoGratisFijo : () => false;
  const FieldValue = admin.firestore.FieldValue;

  const limites = {
    catalogo: new Map(), encuesta: new Map(), sinRespuesta: new Map(), admin: new Map(),
    encuestaGlobal: new Map(), sinRespuestaGlobal: new Map()
  };
  const analizadorJson = express.json({ limit: LIMITE_CUERPO, type: ['application/json', 'text/plain'] });

  function responderError(res, err, mensajeGenerico, etiqueta) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error(`[Público ${etiqueta}]`, err && err.message);
    return res.status(500).json({ error: mensajeGenerico });
  }

  // Límite por IP (en memoria; la IP nunca se guarda) y, si se pide, tope global de la ruta.
  function limitarPublico(req, claseIp, maximoIp, claseGlobal, maximoGlobal) {
    const ip = referidos.ipDeSolicitud(req.headers, req.ip) || 'desconocida';
    if (!permitirSolicitud(limites[claseIp], ip, VENTANA_MS, maximoIp)) {
      throw errorHttp(429, 'Demasiadas solicitudes. Espera unos minutos e intenta de nuevo');
    }
    if (claseGlobal && !permitirSolicitud(limites[claseGlobal], 'global', VENTANA_MS, maximoGlobal)) {
      throw errorHttp(429, 'Demasiadas solicitudes. Espera unos minutos e intenta de nuevo');
    }
  }

  function limitarAdmin(decoded) {
    if (!permitirSolicitud(limites.admin, decoded.uid, 60 * 1000, ADMIN_POR_MINUTO)) {
      throw errorHttp(429, 'Demasiadas solicitudes. Espera un momento e intenta de nuevo');
    }
  }

  async function cuerpoJson(req, res) {
    try {
      await new Promise((resolver, rechazar) => analizadorJson(req, res, err => (err ? rechazar(err) : resolver())));
    } catch (err) {
      if (err && err.type === 'entity.too.large') throw errorHttp(413, 'Los datos enviados son demasiado grandes');
      throw errorHttp(400, 'Los datos enviados no son válidos');
    }
    return req.body;
  }

  // ── Catálogo: una lectura de `cursos` cada 5 minutos, compartida por todas las visitas ──
  let catalogo = null;              // { lista, cargadoEn }
  let lecturaEnCurso = null;
  let ultimoIntento = 0;

  async function leerCatalogo() {
    const snapshot = await db.collection('cursos').get();
    const lista = enc.catalogoPublico(snapshot.docs.map(d => ({ id: d.id, datos: d.data() })), esVideoGratisFijo);
    return { lista, cargadoEn: Date.now() };
  }

  async function obtenerCatalogo() {
    const ahora = Date.now();
    if (catalogo && ahora - catalogo.cargadoEn < CATALOGO_TTL_MS) return catalogo.lista;
    if (lecturaEnCurso) return lecturaEnCurso;
    // Si Firestore falla, no se reintenta en cada visita: se sirve lo último que se tenía.
    if (ahora - ultimoIntento < CATALOGO_REINTENTO_MS) {
      if (catalogo) return catalogo.lista;
      throw errorHttp(503, 'No pudimos cargar los cursos. Intenta de nuevo en un momento');
    }
    ultimoIntento = ahora;
    lecturaEnCurso = leerCatalogo()
      .then(nuevo => { catalogo = nuevo; return nuevo.lista; })
      .catch(error => {
        console.error('[Público catálogo] No se pudo leer cursos:', error && error.message);
        if (catalogo) return catalogo.lista;
        throw errorHttp(503, 'No pudimos cargar los cursos. Intenta de nuevo en un momento');
      })
      .finally(() => { lecturaEnCurso = null; });
    return lecturaEnCurso;
  }

  app.get('/api/cursos/demo', async (req, res) => {
    try {
      limitarPublico(req, 'catalogo', CATALOGO_POR_IP);
      const cursos = await obtenerCatalogo();
      res.set('Cache-Control', CACHE_CATALOGO);
      return res.json({ cursos });
    } catch (error) {
      res.set('Cache-Control', 'no-store');
      return responderError(res, error, 'No pudimos cargar los cursos', 'catalogo');
    }
  });

  // ── Encuesta de la portada ──
  app.post('/api/encuesta', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      limitarPublico(req, 'encuesta', ENCUESTAS_POR_IP, 'encuestaGlobal', ENCUESTAS_GLOBAL);
      const resultado = enc.validarEncuesta(await cuerpoJson(req, res));
      if (!resultado.ok) throw errorHttp(400, resultado.error);
      if (resultado.ignorar) return res.json({ ok: true });
      // Varias copias de la misma sesión son normales (parcial y completa): el panel las junta.
      await db.collection('encuestasProspectos').doc(crypto.randomUUID()).set({
        ...resultado.valor,
        creado: FieldValue.serverTimestamp()
      });
      return res.json({ ok: true });
    } catch (error) {
      return responderError(res, error, 'No se pudo guardar tu respuesta', 'encuesta');
    }
  });

  // ── Preguntas que la guía no supo contestar ──
  app.post('/api/chatbot/sin-respuesta', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      limitarPublico(req, 'sinRespuesta', SIN_RESPUESTA_POR_IP, 'sinRespuestaGlobal', SIN_RESPUESTA_GLOBAL);
      const resultado = enc.validarSinRespuesta(await cuerpoJson(req, res));
      if (!resultado.ok) throw errorHttp(400, resultado.error);
      if (resultado.ignorar) return res.json({ ok: true });
      const { clave, ejemplo, tipo } = resultado.valor;
      const ref = db.collection('chatbotSinRespuesta').doc(clave);
      await db.runTransaction(async tx => {
        const actual = await tx.get(ref);
        tx.set(ref, enc.combinarSinRespuesta(actual.exists ? actual.data() : null, { ejemplo, tipo }, FieldValue.serverTimestamp()));
      });
      return res.json({ ok: true });
    } catch (error) {
      return responderError(res, error, 'No se pudo guardar la pregunta', 'sin-respuesta');
    }
  });

  // ── Administrador: lectura para el panel ──
  app.get('/api/admin/encuesta', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarAdmin(req, res);
      if (!decoded) return undefined;
      limitarAdmin(decoded);
      const limite = enc.limiteDeConsulta(req.query.limite, ENCUESTA_LIMITE_DEFECTO, ENCUESTA_LIMITE_MAXIMO);
      const snapshot = await db.collection('encuestasProspectos').orderBy('creado', 'desc').limit(limite).get();
      return res.json({ docs: snapshot.docs.map(d => enc.filaEncuesta(d.data())) });
    } catch (error) {
      return responderError(res, error, 'No se pudo leer la encuesta', 'admin-encuesta');
    }
  });

  app.get('/api/admin/chatbot/sin-respuesta', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const decoded = await autenticarAdmin(req, res);
      if (!decoded) return undefined;
      limitarAdmin(decoded);
      const limite = enc.limiteDeConsulta(req.query.limite, SIN_RESPUESTA_LIMITE_DEFECTO, SIN_RESPUESTA_LIMITE_MAXIMO);
      const snapshot = await db.collection('chatbotSinRespuesta').orderBy('veces', 'desc').limit(limite).get();
      return res.json({ preguntas: snapshot.docs.map(d => enc.filaSinRespuesta(d.data())) });
    } catch (error) {
      return responderError(res, error, 'No se pudieron leer las preguntas sin respuesta', 'admin-sin-respuesta');
    }
  });

  return { limites };
}

module.exports = {
  montarRutasPublico, VENTANA_MS, ENCUESTAS_POR_IP, SIN_RESPUESTA_POR_IP, CATALOGO_POR_IP,
  ENCUESTAS_GLOBAL, SIN_RESPUESTA_GLOBAL, CATALOGO_TTL_MS
};
