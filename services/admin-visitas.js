'use strict';

// ══ CONTADOR DE VISITAS AGREGADO (apagado por defecto) ══
// Solo SUMA: cuántas visitas hubo cada día y en qué página. No guarda IP, cookies, identificadores, navegador, país ni
// quién fue. La dirección IP se usa únicamente en memoria para limitar abusos y nunca se escribe.
//
//   POST /api/visita  { pagina }   público, siempre 204 (nunca estorba al visitante), solo cuenta si la bandera está en sí
//   Bandera: Firestore config/panel.contadorVisitas (true/false). Se cambia desde Configuración del panel de administración.
//   Datos: visitasDiarias/{AAAA-MM-DD} = { dia, total, paginas: { portada: n, ... } }
//
// Respeta «No rastrear» (DNT: 1) y «Control global de privacidad» (Sec-GPC: 1): esas visitas no se cuentan.
// Antes de encender el contador hay que agregar un párrafo al aviso de privacidad (ver el informe del panel).

const { diaMexico } = require('./admin-panel');

// Solo páginas conocidas: una lista cerrada evita que alguien llene la base con claves inventadas.
const PAGINAS = Object.freeze(['portada', 'aviso-privacidad', 'terminos', 'verificar', 'acceso', 'otra']);
const ALIAS = Object.freeze({
  '': 'portada', '/': 'portada', index: 'portada', inicio: 'portada', landing: 'portada', portada: 'portada',
  'aviso-de-privacidad': 'aviso-privacidad', 'aviso-privacidad': 'aviso-privacidad', privacidad: 'aviso-privacidad',
  'terminos-y-condiciones': 'terminos', terminos: 'terminos', verificar: 'verificar', acceso: 'acceso', login: 'acceso'
});

function normalizarPagina(valor) {
  const t = String(valor === undefined || valor === null ? '' : valor).toLowerCase().trim()
    .replace(/[?#].*$/, '').replace(/\.html?$/, '').replace(/^\/+|\/+$/g, '').slice(0, 60);
  if (Object.prototype.hasOwnProperty.call(ALIAS, t)) return ALIAS[t];
  return 'otra';
}

function visitaNoRastreable(headers = {}) {
  return String(headers.dnt || '').trim() === '1' || String(headers['sec-gpc'] || '').trim() === '1';
}

const CLAVE_CONFIG = Object.freeze({ coleccion: 'config', doc: 'panel' });

// Suma 1 al día y a la página. Con FieldValue.increment es una sola escritura atómica; sin él (pruebas) se usa transacción.
async function registrarVisita(db, FieldValue, { pagina, ahora = new Date() }) {
  const dia = diaMexico(ahora);
  const p = normalizarPagina(pagina);
  const ref = db.collection('visitasDiarias').doc(dia);
  if (FieldValue && typeof FieldValue.increment === 'function') {
    await ref.set({ dia, total: FieldValue.increment(1), paginas: { [p]: FieldValue.increment(1) } }, { merge: true });
  } else {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const actual = snap.exists ? (snap.data() || {}) : {};
      const paginas = actual.paginas && typeof actual.paginas === 'object' ? { ...actual.paginas } : {};
      paginas[p] = (Number(paginas[p]) || 0) + 1;
      tx.set(ref, { dia, total: (Number(actual.total) || 0) + 1, paginas });
    });
  }
  return { dia, pagina: p };
}

module.exports = { PAGINAS, normalizarPagina, visitaNoRastreable, registrarVisita, CLAVE_CONFIG };
