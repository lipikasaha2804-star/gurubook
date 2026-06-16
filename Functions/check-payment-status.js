/**
 * Netlify Function — check-payment-status.js
 *
 * Called when the user returns to the app after a UPI payment
 * (e.g. after GPay closes and they tap "Return to GuruBook").
 * Checks Razorpay to see if the payment for a given order was
 * completed, and if so, writes paidUntil to Firestore exactly
 * like verify-payment.js does.
 *
 * FIX: Uses `phone` (not `deviceId`) to look up the user —
 *      consistent with create-order.js and verify-payment.js.
 *
 * Required env vars:
 *   RAZORPAY_KEY_ID
 *   RAZORPAY_KEY_SECRET
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY
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

  // Accept `phone` — consistent with the rest of the payment system.
  // `orderId` comes from the order created in create-order.js.
  const { orderId, phone } = body;

  if (!orderId || !phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'orderId and phone are required' }) };
  }

  const razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });

  try {
    // ── 1. Fetch all payments for this order ─────────────────────────────────
    const payments = await razorpay.orders.fetchPayments(orderId);
    const successfulPayment = payments.items?.find(p => p.status === 'captured');

    if (!successfulPayment) {
      // Payment not done yet — user may have cancelled or it's still pending
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid: false })
      };
    }

    // ── 2. Determine plan from order notes ───────────────────────────────────
    const order    = await razorpay.orders.fetch(orderId);
    const plan     = order.notes?.plan || 'monthly';
    const duration = PLAN_DURATION_MS[plan] || PLAN_DURATION_MS.monthly;

    // ── 3. Look up user in Firestore by phone ────────────────────────────────
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
        console.error('check-payment-status: user not found for phone:', normalised);
        return {
          statusCode: 404,
          body: JSON.stringify({ error: 'User not found. Please open the GuruBook app first.' })
        };
      }

      userDocRef = snap.docs[0].ref;
    } catch (err) {
      console.error('check-payment-status: Firestore lookup error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Database lookup failed' }) };
    }

    // ── 4. Idempotency: skip if already processed ────────────────────────────
    const userDoc  = await userDocRef.get();
    const userData = userDoc.data() || {};

    if (userData.lastPaymentId === successfulPayment.id) {
      console.log(`check-payment-status: Payment ${successfulPayment.id} already processed — returning success`);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paid:      true,
          paidUntil: userData.paidUntil?.toDate().toISOString()
        })
      };
    }

    // ── 5. Activate: extend from current expiry, not today ───────────────────
    const now              = new Date();
    const currentPaidUntil = userData.paidUntil?.toDate();
    const baseDate         = (currentPaidUntil && currentPaidUntil > now) ? currentPaidUntil : now;
    const paidUntil        = new Date(baseDate.getTime() + duration);

    await userDocRef.update({
      paidUntil:       admin.firestore.Timestamp.fromDate(paidUntil),
      status:          'paid',
      lastPaymentId:   successfulPayment.id,
      lastPaymentPlan: plan,
      lastPaymentAt:   admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`check-payment-status: Activated ${plan} for ${normalised} until ${paidUntil.toISOString()}`);

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
