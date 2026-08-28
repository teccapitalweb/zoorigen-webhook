// Auditoría de solo lectura: compara Firestore contra la cuenta Stripe configurada.
const crypto = require('crypto');
const Stripe = require('stripe');
const admin = require('firebase-admin');

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

function safeId(uid) {
  return crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 12);
}

function asDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value._seconds) return new Date(value._seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firestoreAccess(member) {
  const expires = asDate(member.planVence || member.fechaExpiracion);
  return member.planActivo === true && Boolean(expires && expires.getTime() > Date.now());
}

function stripePeriodEnd(subscription) {
  const seconds = Number(subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

function stripeAccess(subscription) {
  const expires = stripePeriodEnd(subscription);
  return ['active', 'trialing'].includes(subscription.status) && Boolean(expires && expires.getTime() > Date.now());
}

async function listAllSubscriptions() {
  const all = [];
  let startingAfter;
  do {
    const page = await stripe.subscriptions.list({ status: 'all', limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    all.push(...page.data);
    startingAfter = page.has_more ? page.data[page.data.length - 1]?.id : null;
  } while (startingAfter);
  return all;
}

async function main() {
  const [memberSnapshot, stripeSubscriptions] = await Promise.all([
    db.collection('miembros').get(),
    listAllSubscriptions(),
  ]);
  const stripeById = new Map(stripeSubscriptions.map(subscription => [subscription.id, subscription]));
  const firestoreSubscriptionIds = new Set();
  const findings = [];
  const counts = {
    members: memberSnapshot.size,
    firestoreMarkedActive: 0,
    firestoreAccessCurrent: 0,
    stripeLinked: 0,
    stripeVerified: 0,
    manualCurrent: 0,
    staleActive: 0,
    historicalStripeAccount: 0,
    mismatches: 0,
  };

  for (const doc of memberSnapshot.docs) {
    const member = doc.data();
    const markedActive = member.planActivo === true;
    const firestoreCurrent = firestoreAccess(member);
    const subscriptionId = member.stripeSubscriptionId;
    if (markedActive) counts.firestoreMarkedActive += 1;
    if (firestoreCurrent) counts.firestoreAccessCurrent += 1;

    if (!subscriptionId) {
      if (firestoreCurrent && member.activadoManualmente) counts.manualCurrent += 1;
      if (markedActive && !firestoreCurrent) {
        counts.staleActive += 1;
        findings.push({ member: safeId(doc.id), issue: 'firestore_active_but_expired', source: member.activadoManualmente ? 'manual' : member.shopifyOrderId ? 'shopify' : 'unknown' });
      }
      continue;
    }

    counts.stripeLinked += 1;
    firestoreSubscriptionIds.add(subscriptionId);
    let subscription = stripeById.get(subscriptionId);
    if (!subscription) {
      try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
      } catch (error) {
        if (error?.code === 'resource_missing') {
          counts.historicalStripeAccount += 1;
          findings.push({ member: safeId(doc.id), issue: 'subscription_not_in_configured_stripe_account' });
          continue;
        }
        throw error;
      }
    }

    counts.stripeVerified += 1;
    const stripeCurrent = stripeAccess(subscription);
    if (stripeCurrent !== firestoreCurrent) {
      counts.mismatches += 1;
      findings.push({
        member: safeId(doc.id),
        issue: stripeCurrent ? 'stripe_active_firestore_inactive' : 'stripe_inactive_firestore_active',
        stripeStatus: subscription.status,
        stripePeriodEnd: stripePeriodEnd(subscription)?.toISOString() || null,
        firestorePeriodEnd: asDate(member.planVence)?.toISOString() || null,
      });
    }
    if (markedActive && !firestoreCurrent) counts.staleActive += 1;
  }

  const orphanSubscriptions = stripeSubscriptions
    .filter(subscription => !firestoreSubscriptionIds.has(subscription.id))
    .map(subscription => ({ subscription: safeId(subscription.id), status: subscription.status, active: stripeAccess(subscription) }));

  process.stdout.write(JSON.stringify({
    generatedAt: new Date().toISOString(),
    readOnly: true,
    counts,
    findings,
    orphanSubscriptions,
  }, null, 2) + '\n');
}

main().catch(error => {
  console.error('No se pudo completar la auditoría:', error.message);
  process.exitCode = 1;
});
