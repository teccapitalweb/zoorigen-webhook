'use strict';

// ══ RUTAS: pagos de suscripción (administración) ══
//   GET  /api/admin/pagos              cada cobro de Zoorigen, del más reciente al más antiguo: { id, fecha, nombre, correo, plan, tipo ('primer' | 'renov'),
//                                      estado ('pagado' | 'fallido'), monto (pesos), moneda, y en los rechazados: motivo { texto, significa, queHacer, categoria,
//                                      codigo } ya en español, intentos, ultimoIntento y proximoIntento }. Sin ids de Stripe ni datos de la tarjeta.
//                                      Además `rechazos`: los rechazados agrupados por categoría y motivo (para la gráfica «Por qué se rechazan los cobros»).
//   POST /api/admin/pagos/sincronizar  trae de Stripe los cobros pagados que falten, los rechazados que no estuvieran registrados y completa el motivo
//                                      de los rechazados que aún no lo tienen: { suscripciones, revisados, nuevos, errores, fallidosNuevos, motivosCompletados,
//                                      motivosPendientes, motivosErrores }
// Las reglas del servicio están en services/pagos.js y la traducción de motivos en services/motivos-rechazo.js.

const motivos = require('./motivos-rechazo');

function montarRutasAdminPagos(app, deps, a) {
  const { conAdmin, anotarAccion } = a;
  const pagos = deps.pagos;

  app.get('/api/admin/pagos', conAdmin('No se pudieron cargar los pagos', 'pagos', async (req, res) => {
    const lista = await pagos.listar();
    return res.json({ ok: true, generado: new Date().toISOString(), pagos: lista, rechazos: motivos.agruparPorMotivo(lista) });
  }));

  app.post('/api/admin/pagos/sincronizar', a.analizadorJson, conAdmin('No se pudieron traer los pagos desde Stripe', 'pagos-sincronizar', async (req, res, decoded) => {
    const r = await pagos.sincronizar();
    await anotarAccion(decoded, 'pagos-sincronizar', 'stripe', `Trajo los pagos desde Stripe: ${r.nuevos} nuevos, ${r.fallidosNuevos} rechazados nuevos, ${r.motivosCompletados} motivos completados`, { nuevos: r.nuevos, revisados: r.revisados, errores: r.errores, fallidosNuevos: r.fallidosNuevos, motivosCompletados: r.motivosCompletados });
    return res.json({ ok: true, ...r });
  }, { escritura: true }));
}

module.exports = { montarRutasAdminPagos };
