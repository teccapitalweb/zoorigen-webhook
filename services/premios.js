'use strict';

// ══ PREMIOS ══
// Cada premio permite abrir UN curso antes de su fecha (adelanto). Se ganan por nivel o por
// invitados válidos y se canjean solo con membresía vigente. Un premio ganado no se pierde aunque
// el XP baje; se usa una sola vez y el curso no se puede cambiar.

const PREMIOS = Object.freeze([
  {
    clave: 'profesional', titulo: 'Premio Profesional',
    descripcion: 'Abre un curso antes de su fecha del calendario.',
    requisito: 'Llega al nivel Profesional (1,200 puntos)',
    cumple: c => c.nivelId >= 3, faltan: () => null
  },
  {
    clave: 'maestro', titulo: 'Premio Maestro',
    descripcion: 'Abre un curso antes de su fecha del calendario.',
    requisito: 'Llega al nivel Maestro (4,500 puntos)',
    cumple: c => c.nivelId >= 5, faltan: () => null
  },
  {
    clave: 'referidos-1', titulo: 'Premio por invitar (1)',
    descripcion: 'Abre un curso antes de su fecha del calendario.',
    requisito: '3 invitados válidos',
    cumple: c => c.invitadosValidos >= 3, faltan: c => Math.max(0, 3 - c.invitadosValidos)
  },
  {
    clave: 'referidos-2', titulo: 'Premio por invitar (2)',
    descripcion: 'Abre un curso antes de su fecha del calendario.',
    requisito: '6 invitados válidos',
    cumple: c => c.invitadosValidos >= 6, faltan: c => Math.max(0, 6 - c.invitadosValidos)
  }
]);

// Claves de premios cuya condición se cumple hoy. ctx = { nivelId, invitadosValidos }
function clavesQueCumple(ctx) {
  return PREMIOS.filter(p => p.cumple(ctx)).map(p => p.clave);
}

function normalizarGuardado(guardado) {
  const g = guardado && typeof guardado === 'object' ? guardado : {};
  const claves = PREMIOS.map(p => p.clave);
  const ganados = Array.isArray(g.ganados) ? g.ganados.filter(c => claves.includes(c)) : [];
  const usados = Array.isArray(g.usados)
    ? g.usados.filter(u => u && claves.includes(u.clave) && typeof u.cursoId === 'string')
      .map(u => ({ clave: u.clave, cursoId: u.cursoId, fecha: String(u.fecha || '') }))
    : [];
  return { ganados: [...new Set(ganados)], usados };
}

// Lista de premios para el sitio. `disponible` = ganado, sin usar y con membresía para canjearlo.
function armarPremios({ ganados, usados, membresia }) {
  return PREMIOS.map(p => {
    const uso = usados.find(u => u.clave === p.clave);
    const ganado = ganados.includes(p.clave);
    return {
      clave: p.clave, titulo: p.titulo, descripcion: p.descripcion, requisito: p.requisito,
      ganado, usado: uso ? { cursoId: uso.cursoId, fecha: uso.fecha } : null,
      disponible: Boolean(membresia && ganado && !uso)
    };
  });
}

// Primer premio ganado que todavía no se usó (el que consume un canje)
function premioLibre(ganados, usados) {
  return ganados.find(clave => !usados.some(u => u.clave === clave)) || null;
}

module.exports = { PREMIOS, clavesQueCumple, normalizarGuardado, armarPremios, premioLibre };
