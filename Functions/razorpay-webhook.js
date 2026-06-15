/**
 * Netlify Function — razorpay-webhook.js
 *
 * THE SAFETY NET. Activated when the user's browser closes before
 * verify-payment.js can run. Razorpay calls this directly.
 *
 * Setup in Razorpay Dashboard → Settings → Webhooks → Add New Webhook:
 *   Webhook URL: https://1gurubook.netlify.app/.netlify/functions/razorpay-webhook
 *   Secret:      (create any random password, e.g. "gb_wh_secret_2024")
 *   Active Events: Check "payment.captured"
 *
 * Then add that same secret as RAZORPAY_WEBHOOK_SECRET in Netlify env vars.
 *
 * Required env vars (all already exist except the new one):
 *   RAZORPAY_KEY_ID
 *   RAZORPAY_KEY_SECRET
 *   RAZORPAY_WEBHOOK_SECRET   ← NEW — add this in Netlify
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY
 */

const crypto   = require('crypto');
const Razorpay = require('razorpay');
const admin    = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const PLAN_DURATION_MS = {
  monthly: 30  * 24 * 60 * 60 * 1000,
  yearly:  365 * 24 * 60 * 60 * 1000
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── 1. Verify Razorpay webhook signature ──────────────────────────────────
  const receivedSig = event.headers['x-razorpay-signature'];
  if (!receivedSig || !process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.error('Webhook: missing signature or secret');
    return { statusCode: 400, body: 'Missing signature' };
  }

  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(event.body)
    .digest('hex');

  if (receivedSig !== expectedSig) {
    console.error('Webhook: signature mismatch — rejecting');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  // ── 2. Parse payload ──────────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Only handle payment.captured — ignore everything else
  if (payload.event !== 'payment.captured') {
    return { statusCode: 200, body: `Event "${payload.event}" ignored` };
  }

  const payment   = payload.payload?.payment?.entity;
  const orderId   = payment?.order_id;
  const paymentId = payment?.id;

  if (!orderId || !paymentId) {
    console.error('Webhook: no order_id or payment id in payload');
    return { statusCode: 200, body: 'No order_id — skipping' };
  }

  // ── 3. Fetch order to get phone & plan ────────────────────────────────────
  const razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });

  let phone, plan;
  try {
    const order = await razorpay.orders.fetch(orderId);
    phone = order.notes?.phone || '';
    plan  = order.notes?.plan  || 'monthly';
  } catch (err) {
    console.error('Webhook: failed to fetch order:', err);
    return { statusCode: 500, body: 'Could not fetch order' };
  }

  if (!phone) {
    console.error('Webhook: no phone in order notes for order:', orderId);
    return { statusCode: 200, body: 'No phone in order notes — cannot activate' };
  }

  // ── 4. Look up user in Firestore by phone ─────────────────────────────────
  const db         = admin.firestore();
  const normalised = phone.replace(/\D/g, '').slice(-10);

  let userDocRef = null;
  try {
    let snap = await db.collection('users')
      .where('phoneNumber', '==', normalised)
      .limit(1).get();

    if (snap.empty) {
      snap = await db.collection('users')
        .where('phoneNumber', '==', '91' + normalised)
        .limit(1).get();
    }

    if (snap.empty) {
      console.error('Webhook: user not found for phone:', normalised);
      return { statusCode: 200, body: 'User not found — cannot activate' };
    }

    userDocRef = snap.docs[0].ref;
  } catch (err) {
    console.error('Webhook: Firestore lookup error:', err);
    return { statusCode: 500, body: 'Database lookup failed' };
  }

  // ── 5. Idempotency + activate ─────────────────────────────────────────────
  try {
    const userDoc  = await userDocRef.get();
    const userData = userDoc.data() || {};

    if (userData.lastPaymentId === paymentId) {
      console.log(`Webhook: Payment ${paymentId} already processed — skipping`);
      return { statusCode: 200, body: 'Already processed' };
    }

    const validPlan        = PLAN_DURATION_MS[plan] ? plan : 'monthly';
    const now              = new Date();
    const currentPaidUntil = userData.paidUntil?.toDate();
    const baseDate         = (currentPaidUntil && currentPaidUntil > now) ? currentPaidUntil : now;
    const paidUntil        = new Date(baseDate.getTime() + PLAN_DURATION_MS[validPlan]);

    await userDocRef.update({
      paidUntil:       admin.firestore.Timestamp.fromDate(paidUntil),
      status:          'paid',
      lastPaymentId:   paymentId,
      lastPaymentPlan: validPlan,
      lastPaymentAt:   admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Webhook: Activated ${validPlan} for ${normalised} until ${paidUntil.toISOString()}`);
    return { statusCode: 200, body: 'Activated' };

  } catch (err) {
    console.error('Webhook: Firestore update error:', err);
    return { statusCode: 500, body: 'Database update failed' };
  }
};
