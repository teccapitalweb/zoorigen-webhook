'use strict';

// ESCALERA DE RETOS de los 20 materiales nuevos (Excel, PowerPoint y PDF): cada material pide 3 retos más que el anterior,
// de lo más básico a lo más completo. Los retos se cuentan igual que los de los libros (5, 15 y 30): retos superados de la cuenta
// (services/retos.js), solo para miembros con membresía vigente. Los créditos son otra vía independiente (100 créditos = 1 material).
//
// Regla aplicada: el total de retos distintos que un miembro puede superar hoy es 146 (camino: 47 quiz + 60 detective + 39 ordena, con el
// Detective visual y su segunda tanda de 30 escenas; la práctica diaria suma además 1 por tipo y por día). Con paso de 3 el último material pide 60, que es menos
// que el 90 % del total (131), así que se conserva el paso de 3 y todos son alcanzables con holgura.
//
// Orden: primero lo sencillo (carteles, hojas de observación y registros), luego controles de salud y administración, luego lo clínico
// (cuarentena, necropsia, auditoría, rotulado de muestras), después las presentaciones y al final lo legal y más completo.

const PASO = 3;
const TOTAL_RETOS_ALCANZABLES = 146;
const ORDEN = [
  'carteles-visitantes-senales',            //  3  carteles listos para imprimir
  'etograma-hoja-observacion',              //  6  hoja de observación sencilla
  'inventario-botiquin-caducidad',          //  9  registro sencillo (existencias y caducidad)
  'libro-entradas-salidas-insumos',         // 12  registro sencillo con saldo
  'peso-curva-crecimiento',                 // 15  registro con curva
  'control-alimentacion-recintos',          // 18  control diario por recinto
  'bitacora-enriquecimiento-semanal',       // 21  bitácora semanal
  'calendario-preventivo-protocolo',        // 24  calendario con protocolo propio
  'registro-ingresos-bajas-traslados',      // 27  registro de movimientos con resumen anual
  'presupuesto-anual-uma-zoologico',        // 30  presupuesto con gráficas
  'cuarentena-recepcion-ejemplares',        // 33  checklist de cuarentena y recepción
  'formato-necropsia-mortalidad',           // 36  formato de necropsia y mortalidad
  'checklist-auditoria-bienestar',          // 39  auditoría interna de bienestar
  'guia-rotulado-trazabilidad-muestras',    // 42  rotulado y trazabilidad
  'ppt-bioseguridad-recintos',              // 45  presentación de bioseguridad
  'ppt-enriquecimiento-ambiental',          // 48  presentación de enriquecimiento
  'ppt-fototrampeo-muestreo',               // 51  presentación de fototrampeo
  'ppt-observacion-conductual-etogramas',   // 54  presentación de etogramas
  'plantilla-plan-manejo-uma',              // 57  plan de manejo (legal)
  'ppt-uma-pimvs-zoologicos'                // 60  UMA, PIMVS y zoológicos (legal, lo más completo)
];
const ESCALERA = Object.freeze(Object.fromEntries(ORDEN.map((id, i) => [id, (i + 1) * PASO])));

module.exports = { PASO, TOTAL_RETOS_ALCANZABLES, ORDEN, ESCALERA };
