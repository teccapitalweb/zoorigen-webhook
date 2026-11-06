'use strict';

// ══ UMBRALES ANTERIORES de los LIBROS que se abren con retos ══
// Por qué existe: se sube la dificultad de los libros (data/libros/*.json, campo requiereRetos): ley-fauna-mx 5 → 25, bienestar-cautiverio 15 → 35
// y conservacion-mx 30 → 45. La regla acordada con el dueño: quien YA desbloqueó un libro con los umbrales de antes lo conserva; los umbrales
// nuevos solo valen para quien todavía no lo había desbloqueado.
// Esta tabla es el requiereRetos PUBLICADO en origin/main (git show origin/main:data/libros/<id>.json) antes de ese cambio. Con ella,
// services/libros-conservados.js calcula qué libros cumplía cada persona antes y los guarda en librosConservados/{uid}.
// NO se edita: es una fotografía fija. Los libros que se agreguen después no entran aquí (nadie los tenía desbloqueados antes).

const UMBRALES_PREVIOS_LIBROS = Object.freeze({
  'ley-fauna-mx': 5,
  'bienestar-cautiverio': 15,
  'conservacion-mx': 30
});

module.exports = { UMBRALES_PREVIOS_LIBROS };
