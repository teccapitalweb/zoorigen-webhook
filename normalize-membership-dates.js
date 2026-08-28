// Normaliza fechas vigentes guardadas como texto para que las reglas de
// Firestore puedan comparar planVence contra request.time sin cambiar la fecha.
const crypto = require('crypto');
const admin = require('firebase-admin');

const apply = process.argv.includes('--apply');

if (!admin.apps.length) {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
  } else {
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID || 'club-zoorigen',
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: String(process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    });
  }
  admin.initializeApp({ credential });
}

const db = admin.firestore();

function safeId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

async function main() {
  const snapshot = await db.collection('miembros').where('planActivo', '==', true).get();
  const candidates = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (typeof data.planVence !== 'string') continue;
    const date = new Date(data.planVence);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) continue;
    candidates.push({ ref: doc.ref, uid: doc.id, from: data.planVence, to: admin.firestore.Timestamp.fromDate(date) });
  }

  if (apply && candidates.length) {
    const batch = db.batch();
    for (const candidate of candidates) batch.update(candidate.ref, { planVence: candidate.to });
    await batch.commit();
  }

  process.stdout.write(JSON.stringify({
    mode: apply ? 'applied' : 'dry-run',
    normalized: candidates.map(candidate => ({
      member: safeId(candidate.uid),
      from: candidate.from,
      to: candidate.to.toDate().toISOString(),
    })),
  }, null, 2) + '\n');
}

main().catch(error => {
  console.error('No se pudieron normalizar las fechas:', error.message);
  process.exitCode = 1;
});
