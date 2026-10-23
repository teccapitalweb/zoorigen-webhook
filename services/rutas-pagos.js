'use strict';

// ══ RUTAS: pagos de suscripción (administración) ══
//   GET  /api/admin/pagos              cada cobro de Zoorigen, del más reciente al más antiguo: { id, fecha, nombre, correo, plan, tipo ('primer' | 'renov'),
//                                      estado ('pagado' | 'fallido'), monto (pesos), moneda }. Sin ids de Stripe.
//   POST /api/admin/pagos/sincronizar  trae de Stripe los cobros pagados de los miembros y guarda los que falten: { suscripciones, revisados, nuevos, errores }
// Las reglas del servicio están en services/pagos.js.

function montarRutasAdminPagos(app, deps, a) {
  const { conAdmin, anotarAccion } = a;
  const pagos = deps.pagos;

  app.get('/api/admin/pagos', conAdmin('No se pudieron cargar los pagos', 'pagos', async (req, res) => {
    return res.json({ ok: true, generado: new Date().toISOString(), pagos: await pagos.listar() });
  }));

  app.post('/api/admin/pagos/sincronizar', a.analizadorJson, conAdmin('No se pudieron traer los pagos desde Stripe', 'pagos-sincronizar', async (req, res, decoded) => {
    const r = await pagos.sincronizar();
    await anotarAccion(decoded, 'pagos-sincronizar', 'stripe', `Trajo los pagos desde Stripe: ${r.nuevos} nuevos`, { nuevos: r.nuevos, revisados: r.revisados, errores: r.errores });
    return res.json({ ok: true, ...r });
  }, { escritura: true }));
}

module.exports = { montarRutasAdminPagos };
