'use strict';

// Simulador de rutas de XP con las reglas REALES del servidor: arma el estado de una persona (cursos, retos,
// días en el club, foro, invitados...) y calcula su XP con services/logros.js. Lo usan las pruebas de calibración.
const L = require('../../services/logros');
const R = require('../../services/retos');
const REF = require('../../services/referidos');

const AHORA = new Date('2026-12-30T18:00:00Z');
const fechaDe = n => new Date(AHORA.getTime() - n * 86400000).toISOString().slice(0, 10); // hace n días
const diaN = n => new Date(AHORA.getTime() - n * 86400000);

// retos: { camino: cuántos retos del camino (perfectos), practicaDias: días en que se hace práctica (4 retos/día perfectos) }
function estadoRetos({ camino = 0, practicaDias = 0, practicaRetos = ['quiz', 'orden', 'detective', 'historia'] }) {
  let e = R.estadoInicial();
  let hecho = 0;
  const modos = ['quiz', 'orden', 'detective'];
  let k = 0;
  while (hecho < camino) {
    const modo = modos[k % 3]; k++;
    if (e.camino[modo] >= R.TOTALES_CAMINO[modo]) { if (modos.every(m => e.camino[m] >= R.TOTALES_CAMINO[m])) break; continue; }
    const r = R.aplicarCaminoResultado(e, { modo, indice: e.camino[modo], puntaje: 5, total: 5 }, diaN(hecho % 20));
    e = r.estado; hecho++;
  }
  for (let d = 0; d < practicaDias; d++) {
    for (const retoId of practicaRetos) e = R.aplicarResultado(e, { retoId, puntaje: 5, total: 5 }, diaN(30 + d)).estado;
  }
  return e;
}

function ruta(p) {
  const e = estadoRetos(p.retos || {});
  const dias = [];
  const racha = p.racha || 0, total = p.dias || 0;
  for (let i = 0; i < racha; i++) dias.push(fechaDe(i));
  for (let i = 0; dias.length < total; i++) dias.push(fechaDe(racha + 3 + i)); // hueco de 2 días
  const cursosLista = Array.from({ length: p.cursos || 0 }, (_, i) => ({ courseId: 'c' + (i + 1), n: i + 1, xp: L.xpDeCurso(i + 1), fecha: null }));
  const datos = {
    esVIP: true, completados: p.cursos || 0, areas: p.areas || 0, dias, tarjetaDir: !!p.tarjeta,
    foroPosts: p.foroPosts || 0, foroRespuestas: p.foroRespuestas || 0, foroLikes: p.foroLikes || 0,
    invitadosValidos: p.invitados || 0, cursosLista, bienvenida: p.bienvenida !== false
  };
  const xpRef = Math.min(p.invitados || 0, REF.MAX_INVITADOS_CON_XP) * (p.xpPorInvitado == null ? REF.XP_POR_INVITADO : p.xpPorInvitado);
  const ev = L.evaluar(datos, e, xpRef, AHORA);
  return ev;
}

module.exports = { ruta, estadoRetos, AHORA };

