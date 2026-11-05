'use strict';

// ESCALERA DE RETOS de los 20 materiales nuevos (Excel, PowerPoint y PDF), de lo más básico a lo más completo. Los retos se cuentan igual
// que los de los libros (5, 15 y 30): retos superados de la cuenta (services/retos.js), solo para miembros con membresía vigente.
// Los créditos son otra vía independiente (100 créditos = 1 material). El desbloqueo se calcula en cada consulta con el conteo actual
// (superados >= requiereRetos, services/materiales.js): no se guarda nada por material.
//
// Los tres primeros piden 3, 6 y 9 retos y NO se tocan (hoy los miembros llevan como máximo 9 retos, así que nadie pierde nada).
// Del cuarto en adelante la curva sube suave y creciente (el paso crece de 5 a 12 y se afloja al final):
//   14, 19, 25, 31, 38, 45, 52, 60, 69, 79, 90, 101, 113, 124, 134, 142 y 150.
// Diseño: con 35 retos (los del primer cambio de orden de cursos) hay 7 de 20 abiertos; con 55 (el segundo cambio), 10 de 20 (la mitad como máximo);
// con 80, 13; con 120, 16; y el último pide 150, que es menos que el 90 % de los retos que existen (167): queda margen de 36 retos con los 186 de hoy
// y más cuando se activen las escenas de detective que faltan. Los 12 materiales antiguos no se tocan (conservan su propia regla).
//
// Orden: primero lo sencillo (carteles, hojas de observación y registros), luego controles de salud y administración, luego lo clínico
// (cuarentena, necropsia, auditoría, rotulado de muestras), después las presentaciones y al final lo legal y más completo.

const PASO = 3;   // los tres primeros suben de 3 en 3 (3, 6 y 9) y no cambian
const UMBRALES = Object.freeze([3, 6, 9, 14, 19, 25, 31, 38, 45, 52, 60, 69, 79, 90, 101, 113, 124, 134, 142, 150]);
const TOTAL_RETOS_ALCANZABLES = 186;
const ORDEN = [
  'carteles-visitantes-senales',            //  3    carteles listos para imprimir
  'etograma-hoja-observacion',              //  6    hoja de observación sencilla
  'inventario-botiquin-caducidad',          //  9    registro sencillo (existencias y caducidad)
  'libro-entradas-salidas-insumos',         // 14   registro sencillo con saldo
  'peso-curva-crecimiento',                 // 19   registro con curva
  'control-alimentacion-recintos',          // 25   control diario por recinto
  'bitacora-enriquecimiento-semanal',       // 31   bitácora semanal
  'calendario-preventivo-protocolo',        // 38   calendario con protocolo propio
  'registro-ingresos-bajas-traslados',      // 45   registro de movimientos con resumen anual
  'presupuesto-anual-uma-zoologico',        // 52   presupuesto con gráficas
  'cuarentena-recepcion-ejemplares',        // 60   checklist de cuarentena y recepción
  'formato-necropsia-mortalidad',           // 69   formato de necropsia y mortalidad
  'checklist-auditoria-bienestar',          // 79   auditoría interna de bienestar
  'guia-rotulado-trazabilidad-muestras',    // 90   rotulado y trazabilidad
  'ppt-bioseguridad-recintos',              // 101  presentación de bioseguridad
  'ppt-enriquecimiento-ambiental',          // 113  presentación de enriquecimiento
  'ppt-fototrampeo-muestreo',               // 124  presentación de fototrampeo
  'ppt-observacion-conductual-etogramas',   // 134  presentación de etogramas
  'plantilla-plan-manejo-uma',              // 142  plan de manejo (legal)
  'ppt-uma-pimvs-zoologicos'                // 150  UMA, PIMVS y zoológicos (legal, lo más completo)
];
const ESCALERA = Object.freeze(Object.fromEntries(ORDEN.map((id, i) => [id, UMBRALES[i]])));

module.exports = { PASO, UMBRALES, TOTAL_RETOS_ALCANZABLES, ORDEN, ESCALERA };
