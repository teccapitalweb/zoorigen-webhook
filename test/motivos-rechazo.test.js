'use strict';

// Motivos de rechazo de un cobro: tabla de traducción (español claro, «Qué significa» y «Qué hacer»), extracción de lo que dice Stripe SIN datos
// de la tarjeta, y agrupación por categoría. Ejecutar: node --test test/motivos-rechazo.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../services/motivos-rechazo');

const t = (codigo, extra = {}) => M.traducir({ codigo: 'card_declined', declineCodigo: codigo, ...extra });

test('la tabla traduce cada código pedido a su texto en español, con categoría', () => {
  const esperado = {
    insufficient_funds: ['Fondos insuficientes', 'fondos'],
    expired_card: ['Tarjeta vencida', 'tarjeta'],
    incorrect_cvc: ['CVC incorrecto', 'tarjeta'], invalid_cvc: ['CVC incorrecto', 'tarjeta'],
    incorrect_number: ['Número de tarjeta incorrecto', 'tarjeta'], invalid_number: ['Número de tarjeta incorrecto', 'tarjeta'],
    invalid_expiry_month: ['Fecha de vencimiento incorrecta', 'tarjeta'], invalid_expiry_year: ['Fecha de vencimiento incorrecta', 'tarjeta'],
    lost_card: ['El banco bloqueó la tarjeta por seguridad', 'seguridad'], stolen_card: ['El banco bloqueó la tarjeta por seguridad', 'seguridad'],
    pickup_card: ['El banco bloqueó la tarjeta por seguridad', 'seguridad'], restricted_card: ['El banco bloqueó la tarjeta por seguridad', 'seguridad'],
    fraudulent: ['Marcado como posible fraude por el banco o Stripe', 'seguridad'], merchant_blacklist: ['Marcado como posible fraude por el banco o Stripe', 'seguridad'],
    highest_risk_level: ['Marcado como posible fraude por el banco o Stripe', 'seguridad'],
    authentication_required: ['No se completó la verificación del banco', 'verificacion'], authentication_not_handled: ['No se completó la verificación del banco', 'verificacion'],
    payment_intent_authentication_failure: ['No se completó la verificación del banco', 'verificacion'],
    generic_decline: ['El banco rechazó el cobro sin dar detalle', 'banco'],
    do_not_honor: ['El banco no autorizó el cobro', 'banco'], no_action_taken: ['El banco no autorizó el cobro', 'banco']
  };
  for (const [codigo, [texto, categoria]] of Object.entries(esperado)) {
    const r = M.traducir({ codigo, declineCodigo: '' });
    assert.equal(r.texto, texto, codigo);
    assert.equal(r.categoria, categoria, codigo);
    assert.equal(r.codigo, codigo);
  }
  assert.equal(M.traducir({ codigo: 'card_declined' }).texto, 'El banco rechazó el cobro sin dar detalle');
});

test('el código del banco (decline_code) gana al genérico card_declined: «card_declined» + insufficient_funds = Fondos insuficientes', () => {
  assert.equal(t('insufficient_funds').texto, 'Fondos insuficientes');
  assert.equal(t('expired_card').categoria, 'tarjeta');
  assert.equal(t('lost_card').categoria, 'seguridad');
  // un específico en cualquiera de los campos gana al genérico
  assert.equal(M.traducir({ codigo: 'card_declined', declineCodigo: 'generic_decline', razonStripe: 'highest_risk_level' }).categoria, 'seguridad');
  assert.equal(M.traducir({ codigo: 'expired_card', declineCodigo: 'generic_decline' }).texto, 'Tarjeta vencida');
  // si solo hay genéricos, se queda con uno de ellos
  assert.equal(M.traducir({ codigo: 'card_declined', declineCodigo: 'do_not_honor' }).texto, 'El banco no autorizó el cobro');
});

test('los demás códigos de la lista tienen su explicación en español; cualquier otro dice «El banco rechazó el cobro (código: X)»', () => {
  for (const c of ['card_velocity_exceeded', 'withdrawal_count_limit_exceeded', 'transaction_not_allowed', 'currency_not_supported', 'call_issuer', 'try_again_later',
    'issuer_not_available', 'processing_error', 'reenter_transaction', 'service_not_allowed', 'testmode_decline']) {
    const r = M.traducir({ codigo: c });
    assert.ok(M.TABLA[c], c + ' en la tabla');
    assert.ok(r.texto && r.significa && r.queHacer, c);
    assert.ok(!/^El banco rechazó el cobro \(código/.test(r.texto), c + ' tiene texto propio');
    assert.ok(['fondos', 'tarjeta', 'seguridad', 'banco', 'verificacion', 'otro'].includes(r.categoria), c);
  }
  const raro = M.traducir({ codigo: 'algo_muy_nuevo' });
  assert.equal(raro.texto, 'El banco rechazó el cobro (código: algo_muy_nuevo)');
  assert.equal(raro.categoria, 'otro');
  assert.ok(raro.significa && raro.queHacer);
  assert.equal(M.traducir({ tipo: 'card_error' }).texto, 'El banco rechazó el cobro (código: card_error)');
  assert.equal(M.traducir({ codigo: 'Código <b>raro</b>' }), null, 'un código con caracteres raros se descarta');
});

test('cada entrada trae «Qué significa» y «Qué hacer» de una frase, en español y sin el mensaje en inglés de Stripe', () => {
  for (const [c, f] of Object.entries(M.TABLA)) {
    assert.ok(f.significa.length > 15 && f.queHacer.length > 15, c);
    assert.ok(f.significa.endsWith('.') && f.queHacer.endsWith('.'), c + ' termina en punto');
    assert.ok(!/\b(your card|declined|insufficient|the card)\b/i.test(f.texto + f.significa + f.queHacer), c + ' sin inglés');
    assert.ok(!/[\p{Extended_Pictographic}]/u.test(f.texto + f.significa + f.queHacer), c + ' sin emojis');
  }
  assert.match(M.TABLA.insufficient_funds.queHacer, /otra tarjeta/);
  assert.match(M.TABLA.expired_card.queHacer, /actualice su tarjeta/);
  const r = M.traducir({ codigo: 'card_declined', declineCodigo: 'insufficient_funds', mensajeStripe: 'Your card has insufficient funds.' });
  assert.ok(!JSON.stringify(r).includes('Your card'), 'el mensaje en inglés no sale');
  assert.deepEqual(Object.keys(r).sort(), ['categoria', 'codigo', 'queHacer', 'significa', 'texto']);
});

test('traducir: sin motivo guardado no inventa nada', () => {
  for (const x of [null, undefined, {}, 'x', 5, { mensajeStripe: '' }]) assert.equal(M.traducir(x), null, JSON.stringify(x));
});

test('extraerMotivo: toma código, decline_code, tipo y mensaje del intento, y la razón del resultado del cargo; reintento en milisegundos', () => {
  const m = M.extraerMotivo(
    { next_payment_attempt: 1790000000 },
    { last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', type: 'card_error', message: 'Your card has insufficient funds.' } },
    { failure_code: 'card_declined', failure_message: 'Your card has insufficient funds.', outcome: { reason: 'generic_decline', network_status: 'declined_by_network', seller_message: 'The bank returned the decline code `insufficient_funds`.' } }
  );
  assert.deepEqual(m, { codigo: 'card_declined', declineCodigo: 'insufficient_funds', tipo: 'card_error', razonStripe: 'generic_decline', redEstado: 'declined_by_network',
    mensajeStripe: 'Your card has insufficient funds.', reintentoMs: 1790000000000 });
  // sin intento de pago: usa lo del cargo
  const c = M.extraerMotivo({}, null, { failure_code: 'expired_card', failure_message: 'Your card has expired.', outcome: { seller_message: 'x' } });
  assert.deepEqual([c.codigo, c.mensajeStripe, c.reintentoMs], ['expired_card', 'Your card has expired.', null]);
  assert.equal(M.extraerMotivo({}, null, null), null, 'sin datos de Stripe no hay motivo');
  assert.equal(M.extraerMotivo({}, { last_payment_error: {} }, { outcome: {} }), null);
});

test('extraerMotivo NO guarda datos de la tarjeta: solo esas siete claves, y los números del mensaje se tapan', () => {
  const cargo = {
    failure_code: 'card_declined',
    payment_method_details: { card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, fingerprint: 'abc', issuer: 'BANCO DEMO SA' } },
    billing_details: { name: 'Ana Pérez', email: 'ana@example.com', address: { city: 'Mérida' } }, outcome: { reason: 'generic_decline', type: 'issuer_declined' }
  };
  const pi = { last_payment_error: { code: 'card_declined', decline_code: 'generic_decline', type: 'card_error', message: 'Your card ending in 4242 was declined. Card 4242 4242 4242 4242 exp 12/30.',
    payment_method: { card: { last4: '4242', brand: 'visa' }, billing_details: { name: 'Ana Pérez' } }, source: { name: 'Ana' } } };
  const m = M.extraerMotivo({ next_payment_attempt: 1790000000 }, pi, cargo);
  assert.deepEqual(Object.keys(m).sort(), ['codigo', 'declineCodigo', 'mensajeStripe', 'razonStripe', 'redEstado', 'reintentoMs', 'tipo']);
  const texto = JSON.stringify(m).toLowerCase();
  for (const prohibido of ['4242', 'visa', 'banco demo', 'ana', 'mérida', 'fingerprint', 'last4', '2030']) assert.ok(!texto.includes(prohibido), prohibido);
  assert.ok(m.mensajeStripe.length <= 200);
  assert.equal(M.limpiarMensaje('x'.repeat(500)).length, 200);
  assert.equal(M.limpiarMensaje(null), '');
  assert.equal(M.limpiarMensaje('Tarjeta 4000 0000 0000 0002'), 'Tarjeta ···');
});

test('datosIntento: intentos de la factura y fecha del último cargo (o la hora actual)', () => {
  assert.deepEqual(M.datosIntento({ attempt_count: 3 }, { created: 1790000000 }, 5), { intentos: 3, ultimoIntentoMs: 1790000000000 });
  assert.deepEqual(M.datosIntento({}, null, 777), { intentos: 0, ultimoIntentoMs: 777 });
  assert.equal(M.datosIntento({ attempt_count: -2 }, null, 1).intentos, 0);
});

test('agruparPorMotivo: cuenta rechazados por categoría y por motivo, con porcentaje; los sin motivo se cuentan aparte', () => {
  const fila = (estado, categoria, texto) => ({ estado, motivo: categoria ? { categoria, texto } : null });
  const r = M.agruparPorMotivo([
    fila('fallido', 'fondos', 'Fondos insuficientes'), fila('fallido', 'fondos', 'Fondos insuficientes'), fila('fallido', 'tarjeta', 'Tarjeta vencida'),
    fila('fallido', 'banco', 'El banco rechazó el cobro sin dar detalle'), fila('fallido', null), fila('pagado', null), null
  ]);
  assert.deepEqual([r.total, r.conMotivo, r.sinMotivo], [5, 4, 1]);
  assert.deepEqual(r.categorias.map(c => [c.clave, c.nombre, c.n, c.pct]), [['fondos', 'Fondos insuficientes', 2, 50], ['tarjeta', 'Problema con la tarjeta', 1, 25], ['banco', 'Decisión del banco', 1, 25]]);
  assert.deepEqual(r.categorias[0].motivos, [{ texto: 'Fondos insuficientes', n: 2 }]);
  assert.deepEqual(M.agruparPorMotivo([]), { total: 0, conMotivo: 0, sinMotivo: 0, categorias: [] });
  assert.deepEqual(M.agruparPorMotivo(null).categorias, []);
});
