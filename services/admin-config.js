'use strict';

// ══ PANEL DE ADMINISTRACIÓN · interruptores que el servidor guarda (Firestore config/panel) ══
// Solo valores seguros y públicos o internos: nunca claves ni secretos. Se prueba en test/admin-config.test.js.
//
//   contadorVisitas      true/false   enciende el contador agregado de visitas (apagado por defecto)
//   clasesEnVivoPronto   true/false/null   null = que decida el sitio (assets/js/club-config.js)
//   avisoGlobal          { activo, texto, tono }   aviso corto para todo el Club (tono: info | aviso)
//
// GET /api/config-publica sirve clasesEnVivoPronto y avisoGlobal sin sesión. El Club todavía NO los lee: hasta que el
// sitio se actualice para consultarlos, cambiarlos aquí no modifica lo que ven los miembros.

const { aIso } = require('./admin-panel');

const TONOS = Object.freeze(['info', 'aviso']);
const CLAVES = Object.freeze(['contadorVisitas', 'clasesEnVivoPronto', 'avisoGlobal']);
const MAX_TEXTO_AVISO = 240;

const esObjeto = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const limpiar = t => String(t).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXTO_AVISO);

function normalizarConfig(data) {
  const d = esObjeto(data) ? data : {};
  const a = esObjeto(d.avisoGlobal) ? d.avisoGlobal : {};
  return {
    contadorVisitas: d.contadorVisitas === true,
    clasesEnVivoPronto: typeof d.clasesEnVivoPronto === 'boolean' ? d.clasesEnVivoPronto : null,
    avisoGlobal: {
      activo: a.activo === true,
      texto: typeof a.texto === 'string' ? limpiar(a.texto) : '',
      tono: TONOS.includes(a.tono) ? a.tono : 'info'
    },
    actualizadoEn: aIso(d.actualizadoEn),
    actualizadoPor: typeof d.actualizadoPorCorreo === 'string' ? d.actualizadoPorCorreo.slice(0, 160) : ''
  };
}

// Cuerpo de POST /api/admin/config → { error } | { cambios }  (solo las claves enviadas)
function validarCambios(cuerpo) {
  if (!esObjeto(cuerpo)) return { error: 'Los datos enviados no son válidos' };
  const claves = Object.keys(cuerpo);
  if (!claves.length) return { error: 'No hay nada que guardar' };
  const cambios = {};
  for (const k of claves) {
    if (!CLAVES.includes(k)) return { error: 'Hay un ajuste que no existe' };
    const v = cuerpo[k];
    if (k === 'contadorVisitas') {
      if (typeof v !== 'boolean') return { error: 'contadorVisitas debe ser sí o no' };
      cambios.contadorVisitas = v;
    } else if (k === 'clasesEnVivoPronto') {
      if (v !== null && typeof v !== 'boolean') return { error: 'clasesEnVivoPronto debe ser sí, no o automático' };
      cambios.clasesEnVivoPronto = v;
    } else if (k === 'avisoGlobal') {
      if (!esObjeto(v) || typeof v.activo !== 'boolean') return { error: 'El aviso no es válido' };
      const texto = typeof v.texto === 'string' ? limpiar(v.texto) : '';
      if (v.activo && texto.length < 4) return { error: 'Escribe el texto del aviso (mínimo 4 letras) o apágalo' };
      const tono = v.tono === undefined ? 'info' : v.tono;
      if (!TONOS.includes(tono)) return { error: 'El tono del aviso no es válido' };
      cambios.avisoGlobal = { activo: v.activo, texto, tono };
    }
  }
  return { cambios };
}

function vistaPublica(config) {
  const c = normalizarConfig(config);
  const a = c.avisoGlobal;
  return {
    clasesEnVivoPronto: c.clasesEnVivoPronto,
    avisoGlobal: a.activo && a.texto ? { texto: a.texto, tono: a.tono } : null
  };
}

module.exports = { TONOS, CLAVES, MAX_TEXTO_AVISO, normalizarConfig, validarCambios, vistaPublica };
