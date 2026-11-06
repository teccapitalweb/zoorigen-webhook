'use strict';

// ESCALERA DE RETOS de los 20 materiales nuevos (Excel, PowerPoint y PDF), de lo más básico a lo más completo. Los retos se cuentan igual
// que los de los libros (5, 15 y 30): retos superados de la cuenta (services/retos.js), solo para miembros con membresía vigente.
// Los créditos son otra vía independiente (100 créditos = 1 material). El desbloqueo se calcula en cada consulta con el conteo actual
// (superados >= requiereRetos, services/materiales.js): no se guarda nada por material.
//
// Los tres primeros piden 3, 6 y 9 retos y NO se tocan (hoy los miembros llevan como máximo 9 retos, así que nadie pierde nada).
// Del cuarto en adelante la curva sube suave y creciente (el paso crece de 4 a 8 y se afloja al final; en promedio unos 7 retos entre uno y el siguiente):
//   13, 17, 22, 27, 33, 39, 45, 52, 59, 66, 74, 82, 90, 98, 106, 114 y 120.
// Diseño (escalera aprobada por el dueño): con 15 retos hay 4 de 20 abiertos; con 35 (los del primer cambio de orden de cursos), 8; con 55 (el segundo
// cambio), 11; con 80, 14; y con 120 están los 20. El último pide 120, que es menos que el 90 % de los retos que existen (184): queda margen de 85 retos
// con los 205 de hoy (67 quiz, 79 detective y 59 ordena; falta activar 1 escena de detective). Los 12 materiales antiguos no se tocan (conservan su propia regla).
//
// Orden: primero lo sencillo (carteles, hojas de observación y registros), luego controles de salud y administración, luego lo clínico
// (cuarentena, necropsia, auditoría, rotulado de muestras), después las presentaciones y al final lo legal y más completo.

const PASO = 3;   // los tres primeros suben de 3 en 3 (3, 6 y 9) y no cambian
const UMBRALES = Object.freeze([3, 6, 9, 13, 17, 22, 27, 33, 39, 45, 52, 59, 66, 74, 82, 90, 98, 106, 114, 120]);
const TOTAL_RETOS_ALCANZABLES = 205;
const ORDEN = [
  'carteles-visitantes-senales',            //   3    carteles listos para imprimir
  'etograma-hoja-observacion',              //   6    hoja de observación sencilla
  'inventario-botiquin-caducidad',          //   9    registro sencillo (existencias y caducidad)
  'libro-entradas-salidas-insumos',         //  13   registro sencillo con saldo
  'peso-curva-crecimiento',                 //  17   registro con curva
  'control-alimentacion-recintos',          //  22   control diario por recinto
  'bitacora-enriquecimiento-semanal',       //  27   bitácora semanal
  'calendario-preventivo-protocolo',        //  33   calendario con protocolo propio
  'registro-ingresos-bajas-traslados',      //  39   registro de movimientos con resumen anual
  'presupuesto-anual-uma-zoologico',        //  45   presupuesto con gráficas
  'cuarentena-recepcion-ejemplares',        //  52   checklist de cuarentena y recepción
  'formato-necropsia-mortalidad',           //  59   formato de necropsia y mortalidad
  'checklist-auditoria-bienestar',          //  66   auditoría interna de bienestar
  'guia-rotulado-trazabilidad-muestras',    //  74   rotulado y trazabilidad
  'ppt-bioseguridad-recintos',              //  82  presentación de bioseguridad
  'ppt-enriquecimiento-ambiental',          //  90  presentación de enriquecimiento
  'ppt-fototrampeo-muestreo',               //  98  presentación de fototrampeo
  'ppt-observacion-conductual-etogramas',   // 106  presentación de etogramas
  'plantilla-plan-manejo-uma',              // 114  plan de manejo (legal)
  'ppt-uma-pimvs-zoologicos'                // 120  UMA, PIMVS y zoológicos (legal, lo más completo)
];
const ESCALERA = Object.freeze(Object.fromEntries(ORDEN.map((id, i) => [id, UMBRALES[i]])));

module.exports = { PASO, UMBRALES, TOTAL_RETOS_ALCANZABLES, ORDEN, ESCALERA };
