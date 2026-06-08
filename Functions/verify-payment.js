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

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, deviceId, plan } = body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !deviceId || !plan) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }
  if (!PLAN_DURATION_MS[plan]) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid plan' }) };
  }

  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSig !== razorpay_signature) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Payment signature verification failed.' }) };
  }

  const now       = new Date();
  const paidUntil = new Date(now.getTime() + PLAN_DURATION_MS[plan]);

  try {
    const db = admin.firestore();
    await db.collection('users').doc(deviceId).update({
      paidUntil:       admin.firestore.Timestamp.fromDate(paidUntil),
      status:          'paid',
      lastPaymentId:   razorpay_payment_id,
      lastPaymentPlan: plan,
      lastPaymentAt:   admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, paidUntil: paidUntil.toISOString() })
    };
  } catch (err) {
    console.error('Firestore update error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Payment verified but activation failed. Contact support with payment ID: ' + razorpay_payment_id })
    };
  }
};
