/**
 * Netlify Function — check-payment-status.js
 *
 * Called when the user returns to the app after a UPI payment
 * (e.g. after GPay closes). Checks Razorpay to see if the
 * payment for a given order was completed, and if so, writes
 * paidUntil to Firestore just like verify-payment.js does.
 *
 * Required env vars (same as verify-payment.js):
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

  const { orderId, phone } = body;

  if (!orderId || !phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'orderId and phone required' }) };
  }

  const normalised = phone.replace(/\D/g, '').slice(-10);

  const razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });

  try {
    // Fetch all payments for this order from Razorpay
    const payments = await razorpay.orders.fetchPayments(orderId);

    // Find a captured (successful) payment
    const successfulPayment = payments.items?.find(p => p.status === 'captured');

    if (!successfulPayment) {
      // Payment not done yet — user may have cancelled or it's still pending
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid: false })
      };
    }

    // Determine plan from order notes
    const order    = await razorpay.orders.fetch(orderId);
    const plan     = order.notes?.plan || 'monthly';
    const duration = PLAN_DURATION_MS[plan] || PLAN_DURATION_MS.monthly;

    const now       = new Date();
    const paidUntil = new Date(now.getTime() + duration);

    // Look up user by phone
    const db = admin.firestore();
    let userDocRef = null;

    let snap = await db.collection('users')
      .where('phoneNumber', '==', normalised).limit(1).get();
    if (snap.empty) {
      snap = await db.collection('users')
        .where('phoneNumber', '==', '91' + normalised).limit(1).get();
    }
    if (snap.empty) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid: false, error: 'User not found' }) };
    }
    userDocRef = snap.docs[0].ref;

    await userDocRef.update({
      paidUntil:       admin.firestore.Timestamp.fromDate(paidUntil),
      status:          'paid',
      lastPaymentId:   successfulPayment.id,
      lastPaymentPlan: plan,
      lastPaymentAt:   admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`UPI return: Activated ${plan} for ${normalised} until ${paidUntil.toISOString()}`);

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
