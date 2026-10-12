'use strict';

// ══ Auditoría de certificados (npm run audit:certificates) ══
// Los certificados que escribía el navegador no llevan firma del servidor. Desde que el servidor acepta y firma
// SOLO a los anteriores que pasan la revisión (cuando su titular abre el sitio, y los verifica en público), este script
// es una REVISIÓN GLOBAL OPCIONAL con el mismo criterio (certificadoAnteriorAceptable). Los revisa:
//   · por defecto es SOLO LECTURA (dry-run): lista cada certificado con su estado y sus problemas;
//   · con --apply --allowlist=folios.json firma y marca como "legacy-validado" SOLO los folios de esa lista
//     (un arreglo JSON de folios) que pasaron la revisión. No borra ningún campo viejo.
//
// Variables de entorno: FIREBASE_SERVICE_ACCOUNT (o FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
// FIREBASE_PRIVATE_KEY) y CERTIFICATE_SIGNING_KEY (la MISMA que usa el servidor en Railway). Opcional:
// CERTIFICADOS_ANTERIORES_HASTA (la MISMA fecha ISO del servidor) para que el criterio incluya el límite de fecha.
// Las reglas están en services/certificados.js (con pruebas); aquí solo se leen y escriben documentos.

const fs = require('fs');
const path = require('path');
const certificados = require('../services/certificados');

function argumento(nombre, argv = process.argv) {
  const prefijo = `--${nombre}=`;
  const encontrado = argv.find(v => v.startsWith(prefijo));
  return encontrado ? encontrado.slice(prefijo.length) : null;
}

// Lee la lista de folios aprobados: un arreglo JSON de textos con formato de folio
function leerAllowlist(ruta) {
  const lista = JSON.parse(fs.readFileSync(path.resolve(ruta), 'utf8'));
  if (!Array.isArray(lista)) throw new Error('La allowlist debe ser un arreglo JSON de folios');
  return new Set(lista.map(f => String(f).trim().toUpperCase()));
}

function iniciarFirebase() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
    } else {
      credential = admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID || 'club-zoorigen',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: String(process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
      });
    }
    admin.initializeApp({ credential });
  }
  return admin;
}

async function main(argv = process.argv) {
  const aplicar = argv.includes('--apply');
  const rutaAllowlist = argumento('allowlist', argv);
  const llave = String(process.env.CERTIFICATE_SIGNING_KEY || '').trim();
  if (!llave) throw new Error('Falta CERTIFICATE_SIGNING_KEY');
  if (aplicar && !rutaAllowlist) throw new Error('Para aplicar usa --apply --allowlist=folios-aprobados.json');
  const permitidos = aplicar ? leerAllowlist(rutaAllowlist) : new Set();

  const admin = iniciarFirebase();
  const db = admin.firestore();
  const [certs, cursos, miembros, usuarios] = await Promise.all([
    db.collection('certificados').get(),
    db.collection('cursos').select().get(),
    db.collection('miembros').select().get(),
    db.collection('usuarios').select().get() // cuentas anteriores: el servidor también las reconoce como miembro
  ]);
  const filas = certificados.auditarCertificados({
    certificados: certs.docs.map(d => ({ id: d.id, data: d.data() })),
    cursosIds: new Set(cursos.docs.map(d => d.id)),
    miembrosIds: new Set([...miembros.docs, ...usuarios.docs].map(d => d.id)),
    llave,
    ahora: new Date(),
    limite: String(process.env.CERTIFICADOS_ANTERIORES_HASTA || '').trim().replace(/^["']|["']$/g, '')
  });

  const porFolio = new Map(certs.docs.map(d => [d.id, d]));
  let validados = 0;
  const reporte = [];
  for (const fila of filas) {
    let accion = fila.accion;
    if (aplicar && fila.accion === 'revisar-manualmente' && permitidos.has(fila.folio)) {
      const doc = porFolio.get(fila.folio);
      const r = certificados.parcheLegadoValidado(fila.folio, doc.data(), llave);
      if (r.ok) {
        await doc.ref.update({ ...r.parche, validadoEn: admin.firestore.FieldValue.serverTimestamp() });
        accion = 'validado';
        validados += 1;
      }
    }
    // El reporte no incluye nombres: el folio basta para abrir el documento y revisarlo
    reporte.push({ folio: fila.folio, accion, razones: fila.razones, notas: fila.notas, uid: fila.uid, cursoId: fila.cursoId });
  }

  const resumen = reporte.reduce((acc, f) => { acc[f.accion] = (acc[f.accion] || 0) + 1; return acc; }, {});
  const salida = { modo: aplicar ? 'aplicar-allowlist' : 'solo-auditoria', total: reporte.length, validados, resumen, certificados: reporte };
  process.stdout.write(JSON.stringify(salida, null, 2) + '\n');
  return salida;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(error => {
    console.error('No se pudo auditar los certificados:', error.message);
    process.exit(1);
  });
}

module.exports = { main, argumento, leerAllowlist };
