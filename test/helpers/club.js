'use strict';

// Ayudas comunes de las pruebas de retos, premios, referidos y directorio.
const request = require('supertest');
const { cargarServidor, ts, dias } = require('./cargar-servidor');
const logros = require('../../services/logros');

const AREAS = ['Manejo', 'Conservación', 'Legislación', 'Bioseguridad', 'Veterinaria'];
const uuid = n => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

// n cursos c1..cn, con área rotativa, tres clases cada uno (el 1 y el 2 son elegibles como prueba)
function cursosSeed(n = 15, extra = {}) {
  const seed = {};
  for (let i = 1; i <= n; i++) {
    seed[`cursos/c${i}`] = {
      titulo: `Curso ${i}`, area: AREAS[(i - 1) % AREAS.length], ordenVip: i,
      lecciones: [1, 2, 3].map(k => ({ titulo: `Clase ${k}`, videoId: uuid(i * 10 + k), provider: 'bunny' }))
    };
  }
  return { ...seed, ...extra };
}

const miembroConPlan = (extra = {}) => ({
  name: 'Persona Prueba', planActivo: true, planCancelado: false, planStatus: 'active', planTipo: 'mensual',
  planVence: ts(dias(20)), ultimoPago: ts(dias(-5)), stripeSubscriptionId: 'sub_x', role: 'member', ...extra
});
const miembroSinPlan = (extra = {}) => ({
  name: 'Persona Sin Plan', planActivo: false, planCancelado: false, planTipo: null, planInicio: null,
  planVence: null, ultimoPago: null, role: 'member', ...extra
});

const auth = t => ({ Authorization: `Bearer ${t}` });
// token-<uid> => { uid, email }
const tokensDe = (...uids) => Object.fromEntries(uids.map(uid => [`token-${uid}`, { uid, email: `${uid}@example.com` }]));

// 'YYYY-MM-DD' de hace n días en México
const fechaHace = n => logros.fechaMexico(new Date(Date.now() - n * 86400000));
const diasSeguidosHasta = (cantidad, hace = 0) => Array.from({ length: cantidad }, (_, i) => fechaHace(hace + i)).reverse();

const certificado = (uid, courseId, extra = {}) => ({
  folio: `ZOO-2026-${courseId}-${uid}`, courseId: String(courseId), courseTitle: `Curso ${courseId}`, memberUid: uid, issuedAt: new Date().toISOString(), ...extra
});

module.exports = {
  request, cargarServidor, ts, dias, AREAS, uuid, cursosSeed, miembroConPlan, miembroSinPlan, auth, tokensDe,
  fechaHace, diasSeguidosHasta, certificado
};
