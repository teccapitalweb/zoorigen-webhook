'use strict';

// Feeds de prueba: lee test/fixtures y arma un fetch falso. Las pruebas de noticias NUNCA tocan internet.
const fs = require('fs');
const path = require('path');

const fixture = nombre => fs.readFileSync(path.join(__dirname, '..', 'fixtures', `${nombre}.xml`));

const FUENTES = [
  { id: 'mongabay', nombre: 'Mongabay Latam', url: 'https://es.mongabay.com/feed/', categoria: 'conservacion', fixture: 'feed-mongabay' },
  { id: 'dw', nombre: 'DW Ambiente', url: 'https://rss.dw.com/rdf/rss-sp-eco', categoria: 'ciencia', fixture: 'feed-dw-rdf' },
  { id: 'natgeo', nombre: 'National Geographic ES', url: 'https://www.nationalgeographic.com.es/rss/animales', categoria: 'fauna', fixture: 'feed-natgeo' },
  { id: 'apicultura', nombre: 'Apicultura al día', url: 'https://apicultura.example.org/feed.atom', categoria: 'apicultura', fixture: 'feed-atom-apicultura' }
];
const fuentesSinFixture = () => FUENTES.map(({ fixture: _f, ...f }) => f);

// respuestas: { url: Buffer|string | Error | función(url) }. Lo que no esté responde 404.
// `llamadas` guarda las URL pedidas (sin la llave de NewsData, que no debe aparecer en los registros).
function fetchFalso(respuestas, llamadas = []) {
  const f = async (url, opciones = {}) => {
    llamadas.push(String(url));
    let r = respuestas[url];
    if (r === undefined) {
      const clave = Object.keys(respuestas).find(k => String(url).startsWith(k));
      r = clave ? respuestas[clave] : undefined;
    }
    if (typeof r === 'function') r = await r(url, opciones);
    if (r instanceof Error) throw r;
    if (r === undefined) return new Response('no encontrado', { status: 404 });
    if (r instanceof Response) return r;
    return new Response(r, { status: 200, headers: { 'content-type': 'application/xml' } });
  };
  f.llamadas = llamadas;
  return f;
}

const respuestasDeFixtures = () => Object.fromEntries(FUENTES.map(f => [f.url, fixture(f.fixture)]));

module.exports = { fixture, FUENTES, fuentesSinFixture, fetchFalso, respuestasDeFixtures };
