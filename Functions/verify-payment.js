/**
 * Netlify Function — verify-payment.js
 * HARDENED VERSION: idempotency + extends paidUntil from current expiry
 */

const crypto = require('crypto');
const admin  = require('firebase-admin');

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

  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    phone,
    plan
  } = body;

  // ── 1. Verify Razorpay signature ─────────────────────────────────────────
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing payment fields' }) };
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + '|' + razorpay_payment_id)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    console.error('Signature mismatch — possible fraud attempt');
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid payment signature' }) };
  }

  // ── 2. Look up user in Firestore by phone ────────────────────────────────
  if (!phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'phone is required' }) };
  }

  const db = admin.firestore();
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
      console.error('User not found for phone:', normalised);
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'User not found. Please open the GuruBook app first.' })
      };
    }

    userDocRef = snap.docs[0].ref;
  } catch (err) {
    console.error('Firestore lookup error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Database lookup failed' }) };
  }

  // ── 3. Idempotency: skip if already processed ────────────────────────────
  try {
    const userDoc  = await userDocRef.get();
    const userData = userDoc.data() || {};

    if (userData.lastPaymentId === razorpay_payment_id) {
      console.log(`Payment ${razorpay_payment_id} already processed — returning success`);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success:   true,
          paidUntil: userData.paidUntil?.toDate().toISOString()
        })
      };
    }

    // ── 4. Activate: extend from current expiry, not today ────────────────
    const validPlan      = PLAN_DURATION_MS[plan] ? plan : 'monthly';
    const now            = new Date();
    const currentPaidUntil = userData.paidUntil?.toDate();
    const baseDate       = (currentPaidUntil && currentPaidUntil > now) ? currentPaidUntil : now;
    const paidUntil      = new Date(baseDate.getTime() + PLAN_DURATION_MS[validPlan]);

    await userDocRef.update({
      paidUntil:       admin.firestore.Timestamp.fromDate(paidUntil),
      status:          'paid',
      lastPaymentId:   razorpay_payment_id,
      lastPaymentPlan: validPlan,
      lastPaymentAt:   admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Activated ${validPlan} for ${normalised} until ${paidUntil.toISOString()}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:   true,
        paidUntil: paidUntil.toISOString()
      })
    };
  } catch (err) {
    console.error('Firestore update error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Payment verified but activation failed. Contact support.' })
    };
  }
};
