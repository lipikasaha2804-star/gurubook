/**
 * Netlify Function — check-payment-status.js
 * HARDENED VERSION: Uses phone number from order notes (consistent
 * with verify-payment.js). Fixes the deviceId bug. Adds idempotency
 * and paidUntil extension.
 *
 * Called by pay.html when user returns from UPI app.
 * Accepts: { orderId: "order_..." }
 */

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

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { orderId } = body;

  if (!orderId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'orderId is required' }) };
  }

  const razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });

  try {
    // ── 1. Fetch order to get phone & plan from notes ─────────────────────
    const order = await razorpay.orders.fetch(orderId);
    const plan  = order.notes?.plan  || 'monthly';
    const phone = order.notes?.phone || '';

    if (!phone) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Phone not in order notes — cannot activate' })
      };
    }

    // ── 2. Check if any payment was captured for this order ───────────────
    const payments = await razorpay.orders.fetchPayments(orderId);
    const successfulPayment = payments.items?.find(p => p.status === 'captured');

    if (!successfulPayment) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid: false })
      };
    }

    // ── 3. Look up user by phone (same as verify-payment.js) ─────────────
    const db         = admin.firestore();
    const normalised = phone.replace(/\D/g, '').slice(-10);

    let snap = await db.collection('users')
      .where('phoneNumber', '==', normalised)
      .limit(1).get();

    if (snap.empty) {
      snap = await db.collection('users')
        .where('phoneNumber', '==', '91' + normalised)
        .limit(1).get();
    }

    if (snap.empty) {
      console.error('UPI-return: User not found for phone:', normalised);
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'User not found. Please open the GuruBook app first.' })
      };
    }

    const userDocRef = snap.docs[0].ref;

    // ── 4. Idempotency check ──────────────────────────────────────────────
    const userDoc  = await userDocRef.get();
    const userData = userDoc.data() || {};

    if (userData.lastPaymentId === successfulPayment.id) {
      console.log(`UPI-return: Payment ${successfulPayment.id} already processed`);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paid:      true,
          paidUntil: userData.paidUntil?.toDate().toISOString()
        })
      };
    }

    // ── 5. Activate: extend from current expiry ───────────────────────────
    const duration     = PLAN_DURATION_MS[plan] || PLAN_DURATION_MS.monthly;
    const now          = new Date();
    const currentPaidUntil = userData.paidUntil?.toDate();
    const baseDate     = (currentPaidUntil && currentPaidUntil > now) ? currentPaidUntil : now;
    const paidUntil    = new Date(baseDate.getTime() + duration);

    await userDocRef.update({
      paidUntil:       admin.firestore.Timestamp.fromDate(paidUntil),
      status:          'paid',
      lastPaymentId:   successfulPayment.id,
      lastPaymentPlan: plan,
      lastPaymentAt:   admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`UPI-return: Activated ${plan} for ${normalised} until ${paidUntil.toISOString()}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paid:      true,
        paidUntil: paidUntil.toISOString()
      })
    };

  } catch (err) {
    console.error('check-payment-status error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Could not check payment status' })
    };
  }
};
