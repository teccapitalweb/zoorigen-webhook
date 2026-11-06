'use strict';

// ══ UMBRALES ANTERIORES de los materiales que se abren con retos ══
// Por qué existe: la escalera nueva de materiales (data/materiales/catalogo.json) sube el requiereRetos de materiales que YA estaban publicados
// (por ejemplo 12 → 13, 18 → 22, 60 → 120). La regla acordada con el dueño: lo que una persona YA desbloqueó con los umbrales de antes
// debe seguir desbloqueado; los umbrales nuevos solo valen para quien todavía no lo desbloqueó.
// Esta tabla es el requiereRetos PUBLICADO en origin/main (git show origin/main:data/materiales/catalogo.json) de cada material de acceso
// «retos». Con ella, services/materiales-conservados.js calcula qué materiales cumplía cada persona antes del cambio y los guarda en
// materialesConservados/{uid}. NO se edita: es una fotografía fija del catálogo publicado antes de la escalera nueva. Los materiales
// que se agreguen después no entran aquí (nadie los tenía desbloqueados antes).

const UMBRALES_PREVIOS = Object.freeze({
  'intro-nom-059': 3,
  'bienestar-cinco-dominios': 10,
  'polinizadores-abejas': 20,
  'inventario-botiquin-caducidad': 9,
  'libro-entradas-salidas-insumos': 12,
  'peso-curva-crecimiento': 15,
  'calendario-preventivo-protocolo': 24,
  'registro-ingresos-bajas-traslados': 27,
  'presupuesto-anual-uma-zoologico': 30,
  'bitacora-enriquecimiento-semanal': 21,
  'control-alimentacion-recintos': 18,
  'ppt-bioseguridad-recintos': 45,
  'ppt-enriquecimiento-ambiental': 48,
  'ppt-fototrampeo-muestreo': 51,
  'ppt-uma-pimvs-zoologicos': 60,
  'ppt-observacion-conductual-etogramas': 54,
  'cuarentena-recepcion-ejemplares': 33,
  'formato-necropsia-mortalidad': 36,
  'plantilla-plan-manejo-uma': 57,
  'etograma-hoja-observacion': 6,
  'carteles-visitantes-senales': 3,
  'checklist-auditoria-bienestar': 39,
  'guia-rotulado-trazabilidad-muestras': 42
});

module.exports = { UMBRALES_PREVIOS };
