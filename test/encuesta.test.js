'use strict';

// Reglas puras de services/encuesta.js (sin servidor ni Firestore).
const test = require('node:test');
const assert = require('node:assert/strict');
const enc = require('../services/encuesta');

test('normalizarNumero: acepta separadores comunes y exige de 8 a 15 dígitos', () => {
  assert.equal(enc.normalizarNumero('5212361113237'), '5212361113237');
  assert.equal(enc.normalizarNumero(' +52 (236) 111-32.37 '), '522361113237');
  assert.equal(enc.normalizarNumero('12345678'), '12345678');
  assert.equal(enc.normalizarNumero('1'.repeat(15)), '1'.repeat(15));
  for (const malo of ['1234567', '1'.repeat(16), 'abc', '123 45x678', '', '++5212361113237', null, undefined, 5212361113237, {}]) {
    assert.equal(enc.normalizarNumero(malo), '', String(malo));
  }
});

test('limpiarTextoChatbot: quita correos, usuarios, URLs y teléfonos de 7 o más dígitos', () => {
  assert.equal(enc.limpiarTextoChatbot('  ¿Qué   come el   jaguar?  '), '¿Qué come el jaguar?');
  assert.equal(enc.limpiarTextoChatbot('llámame al 2361113237 qué come el tapir'), 'llámame al qué come el tapir');
  assert.equal(enc.limpiarTextoChatbot('mi tel +52 236 111 3237 y el tapir'), 'mi tel y el tapir');
  assert.equal(enc.limpiarTextoChatbot('escribe a ana@mail.com sobre el tapir'), 'escribe a sobre el tapir');
  assert.equal(enc.limpiarTextoChatbot('ve https://x.com/a?b=1 o www.sitio.mx/ruta del tapir'), 've o del tapir');
  assert.equal(enc.limpiarTextoChatbot('sígueme @ana_perez y dime del tapir'), 'sígueme y dime del tapir');
  // números cortos (edad, cantidades) se conservan
  assert.equal(enc.limpiarTextoChatbot('un tapir de 25 años y 300 kg'), 'un tapir de 25 años y 300 kg');
  assert.equal(enc.limpiarTextoChatbot('ab'), '');
  assert.equal(enc.limpiarTextoChatbot('987654321'), '');
  assert.equal(enc.limpiarTextoChatbot(12345), '');
  assert.equal(enc.limpiarTextoChatbot('a\u0000b​c d'), 'abc d');
});

test('limpiarTextoChatbot: recorta a 120 sin partir caracteres ni dejar partes de un correo', () => {
  const largo = enc.limpiarTextoChatbot(`${'palabra '.repeat(40)}correo@dominio.com`);
  assert.ok(largo.length <= 120);
  assert.ok(!largo.includes('@'));
  assert.equal(enc.limpiarTextoChatbot('x'.repeat(5000)).length, 120);
});

test('claveChatbot: minúsculas, sin acentos ni signos, espacios simples y máximo 80', () => {
  assert.equal(enc.claveChatbot('¿Qué  COME el Ñandú, señor?'), 'que come el nandu senor');
  assert.equal(enc.claveChatbot('  ---  '), '');
  const larga = enc.claveChatbot('palabra '.repeat(30));
  assert.ok(larga.length <= 80);
  assert.match(larga, /-[0-9a-f]{8}$/);
  // dos textos largos que solo se distinguen al final no chocan
  assert.notEqual(enc.claveChatbot(`${'palabra '.repeat(20)}final uno`), enc.claveChatbot(`${'palabra '.repeat(20)}final dos`));
  // la clave siempre sirve como id de documento (sin barras ni puntos)
  assert.match(enc.claveChatbot('a/b\\c.d__e'), /^[a-z0-9 -]+$/);
});

test('combinarSinRespuesta: crea y suma veces conservando el primer ejemplo', () => {
  const nuevo = enc.combinarSinRespuesta(null, { ejemplo: 'qué come el tapir', tipo: 'animal' }, 'T1');
  assert.deepEqual(nuevo, { ejemplo: 'qué come el tapir', tipo: 'animal', veces: 1, primeraVez: 'T1', ultimaVez: 'T1' });
  const suma = enc.combinarSinRespuesta(nuevo, { ejemplo: 'Qué come el Tapir?', tipo: 'otro' }, 'T2');
  assert.equal(suma.veces, 2);
  assert.equal(suma.ejemplo, 'qué come el tapir');
  assert.equal(suma.primeraVez, 'T1');
  assert.equal(suma.ultimaVez, 'T2');
  assert.equal(enc.combinarSinRespuesta({ veces: 'x' }, { ejemplo: 'a b c', tipo: 'otro' }, 'T').veces, 1);
});

test('validarEncuesta: sessionId se recorta y las respuestas se limpian', () => {
  const ok = enc.validarEncuesta({ sessionId: '  s1  ', respuestas: { p1: '  Estudiante  ' }, completada: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.valor.sessionId, 's1');
  assert.deepEqual(ok.valor.respuestas, { p1: 'Estudiante' });
  assert.equal(ok.ignorar, false);
  assert.equal(enc.validarEncuesta(null).ok, false);
  assert.equal(enc.validarEncuesta({ sessionId: 's', respuestas: {}, completada: false }).ignorar, true);
  assert.deepEqual(enc.CLAVES_RESPUESTA, ['meta', 'p1', 'origen', 'grupo', 'p2', 'p2b', 'tamano', 'experiencia', 'urgencia', 'freno']);
});

test('cursoPublico: solo campos permitidos, aunque el curso traiga videos y preguntas', () => {
  const curso = {
    title: ' Título ', description: 'Texto', area: 'Manejo', instructor: 'X', image: 'https://i.example/a.png',
    lecciones: [
      { titulo: 'A', videoId: 'bbbbbbbb-0000-4000-8000-000000000001', url: 'https://v.example/1', preguntas: [{ correcta: 1 }] },
      { titulo: 'B', videoId: 'bbbbbbbb-0000-4000-8000-000000000002' }
    ]
  };
  const publico = enc.cursoPublico('c1', curso);
  assert.deepEqual(publico, {
    id: 'c1', titulo: 'Título', area: 'Manejo', descripcion: 'Texto', clases: 2, proximamente: false, elegiblePrueba: true
  });
  assert.equal(enc.cursoPublico('c2', { ...curso, visible: false }), null);
  assert.equal(enc.cursoPublico('c3', { ...curso, activo: false }), null);
  assert.equal(enc.cursoPublico('c4', { ...curso, estado: ' Archivado ' }), null);
  assert.equal(enc.cursoPublico('c5', { title: 'Viejo', driveId: 'abc' }).clases, 1);
  assert.equal(enc.cursoPublico('c6', { title: 'Viejo', totalClases: 4 }).clases, 4);
  assert.equal(enc.cursoPublico('c7', null), null);
  assert.equal(enc.cursoPublico('', curso), null);
});
