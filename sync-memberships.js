// Reparacion controlada: Stripe es la fuente de verdad y solo se escriben
// suscripciones solicitadas explicitamente con --subscription.
const crypto = require('crypto');
const Stripe = require('stripe');
const admin = require('firebase-admin');

const apply = process.argv.includes('--apply');
const subscriptionIds = process.argv
  .filter(argument => argument.startsWith('--subscription='))
  .map(argument => argument.slice('--subscription='.length).trim())
  .filter(Boolean);

if (!subscriptionIds.length) {
  throw new Error('Indica al menos una suscripcion con --subscription=sub_...');
}

const stripeKey = String(process.env.STRIPE_SECRET_KEY || '').trim().replace(/^["']|["']$/g, '');
if (!stripeKey) throw new Error('Falta STRIPE_SECRET_KEY');
const stripe = Stripe(stripeKey);

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
const allowedPrices = new Map([
  [process.env.STRIPE_PRICE_MENSUAL || 'price_1TRcJnA7If2CqXs9dMBGRmDF', 'mensual'],
  [process.env.STRIPE_PRICE_ANUAL || 'price_1TRcJlA7If2CqXs97WQNmKFq', 'anual'],
]);

function safeId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function unixValue(subscription, field) {
  return Number(subscription[field] || subscription.items?.data?.[0]?.[field]);
}

async function prepare(subscriptionId) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const planTipo = allowedPrices.get(priceId);
  if (!planTipo) throw new Error(`La suscripcion ${safeId(subscriptionId)} no pertenece a un precio Zoorigen`);
  if (!['active', 'trialing'].includes(subscription.status)) {
    throw new Error(`La suscripcion ${safeId(subscriptionId)} no esta activa (${subscription.status})`);
  }

  const periodEndSeconds = unixValue(subscription, 'current_period_end');
  const periodStartSeconds = unixValue(subscription, 'current_period_start');
  if (!Number.isFinite(periodEndSeconds) || periodEndSeconds * 1000 <= Date.now()) {
    throw new Error(`La suscripcion ${safeId(subscriptionId)} no tiene un periodo vigente`);
  }

  const members = await db.collection('miembros')
    .where('stripeSubscriptionId', '==', subscriptionId)
    .limit(2)
    .get();
  if (members.size !== 1) {
    throw new Error(`Se esperaban 1 miembro para ${safeId(subscriptionId)} y se encontraron ${members.size}`);
  }

  const memberDoc = members.docs[0];
  const current = memberDoc.data();
  if (current.stripeCustomerId && current.stripeCustomerId !== subscription.customer) {
    throw new Error(`El cliente Stripe no coincide para ${safeId(subscriptionId)}`);
  }

  const invoices = await stripe.invoices.list({ subscription: subscriptionId, status: 'paid', limit: 1 });
  const latestPaidInvoice = invoices.data[0];
  if (!latestPaidInvoice) throw new Error(`No hay factura pagada para ${safeId(subscriptionId)}`);
  const paidAtSeconds = Number(latestPaidInvoice.status_transitions?.paid_at || latestPaidInvoice.created);

  return {
    uid: memberDoc.id,
    subscriptionId,
    customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
    status: subscription.status,
    planTipo,
    planCancelado: subscription.cancel_at_period_end === true,
    planInicio: Number.isFinite(periodStartSeconds) ? admin.firestore.Timestamp.fromMillis(periodStartSeconds * 1000) : null,
    planVence: admin.firestore.Timestamp.fromMillis(periodEndSeconds * 1000),
    ultimoPago: admin.firestore.Timestamp.fromMillis(paidAtSeconds * 1000),
  };
}

async function writePrepared(item) {
  const common = {
    planActivo: true,
    planCancelado: item.planCancelado,
    planStatus: item.planCancelado ? 'cancelled_active' : 'active',
    stripeCustomerId: item.customerId,
    stripeSubscriptionId: item.subscriptionId,
    stripeSubscriptionStatus: item.status,
    actualizadoDesdeStripe: admin.firestore.FieldValue.serverTimestamp(),
    ultimoPago: item.ultimoPago,
  };
  const member = {
    ...common,
    planTipo: item.planTipo,
    planVence: item.planVence,
    ...(item.planInicio ? { planInicio: item.planInicio } : {}),
  };
  const user = {
    ...common,
    tipoPlan: item.planTipo,
    fechaExpiracion: item.planVence,
    ...(item.planInicio ? { fechaActivacion: item.planInicio } : {}),
  };
  const batch = db.batch();
  batch.set(db.collection('miembros').doc(item.uid), member, { merge: true });
  batch.set(db.collection('usuarios').doc(item.uid), user, { merge: true });
  await batch.commit();
}

async function main() {
  const prepared = [];
  for (const subscriptionId of [...new Set(subscriptionIds)]) prepared.push(await prepare(subscriptionId));

  if (apply) {
    for (const item of prepared) await writePrepared(item);
  }

  process.stdout.write(JSON.stringify({
    mode: apply ? 'applied' : 'dry-run',
    memberships: prepared.map(item => ({
      member: safeId(item.uid),
      subscription: safeId(item.subscriptionId),
      status: item.status,
      planTipo: item.planTipo,
      planCancelado: item.planCancelado,
      expiresAt: item.planVence.toDate().toISOString(),
    })),
  }, null, 2) + '\n');
}

main().catch(error => {
  console.error('No se pudo sincronizar:', error.message);
  process.exitCode = 1;
});
