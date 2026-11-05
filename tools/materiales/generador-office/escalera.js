'use strict';

// ESCALERA DE RETOS de los 20 materiales nuevos (Excel, PowerPoint y PDF), de lo más básico a lo más completo. Los retos se cuentan igual
// que los de los libros (5, 15 y 30): retos superados de la cuenta (services/retos.js), solo para miembros con membresía vigente.
// Los créditos son otra vía independiente (100 créditos = 1 material).
//
// Los primeros 10 materiales piden 3, 6, 9 ... 30 retos (de 3 en 3). Los ÚLTIMOS 10 suben la dificultad para que, con tantos retos
// en el camino, no se abran todos demasiado pronto: 36, 42, 50, 58, 66, 76, 86, 96, 108 y 120.
//
// Regla aplicada: el total de retos distintos que un miembro puede superar hoy es 186 (camino: 67 quiz + 60 detective + 59 ordena, con el
// Detective visual y tres tandas de quiz y de ordena; la práctica diaria suma además 1 por tipo y por día, y las escenas de detective que
// falten por activar sumarán más). El último pide 120, que es menos que el 90 % del total (167): todos son alcanzables y queda margen
// (66 retos de sobra con los 186 de hoy). Los 12 materiales antiguos no se tocan (conservan su propia regla: 3, 10 y 20 retos y 6 por membresía).
//
// Orden: primero lo sencillo (carteles, hojas de observación y registros), luego controles de salud y administración, luego lo clínico
// (cuarentena, necropsia, auditoría, rotulado de muestras), después las presentaciones y al final lo legal y más completo.

const PASO = 3;   // los primeros 10 suben de 3 en 3
const UMBRALES = Object.freeze([3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 36, 42, 50, 58, 66, 76, 86, 96, 108, 120]);
const TOTAL_RETOS_ALCANZABLES = 186;
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
  'cuarentena-recepcion-ejemplares',        // 36  checklist de cuarentena y recepción
  'formato-necropsia-mortalidad',           // 42  formato de necropsia y mortalidad
  'checklist-auditoria-bienestar',          // 50  auditoría interna de bienestar
  'guia-rotulado-trazabilidad-muestras',    // 58  rotulado y trazabilidad
  'ppt-bioseguridad-recintos',              // 66  presentación de bioseguridad
  'ppt-enriquecimiento-ambiental',          // 76  presentación de enriquecimiento
  'ppt-fototrampeo-muestreo',               // 86  presentación de fototrampeo
  'ppt-observacion-conductual-etogramas',   // 96  presentación de etogramas
  'plantilla-plan-manejo-uma',              // 108  plan de manejo (legal)
  'ppt-uma-pimvs-zoologicos'                // 120  UMA, PIMVS y zoológicos (legal, lo más completo)
];
const ESCALERA = Object.freeze(Object.fromEntries(ORDEN.map((id, i) => [id, UMBRALES[i]])));

module.exports = { PASO, UMBRALES, TOTAL_RETOS_ALCANZABLES, ORDEN, ESCALERA };
