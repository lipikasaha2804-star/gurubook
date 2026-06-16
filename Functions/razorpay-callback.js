/**
 * Netlify Function — razorpay-callback.js
 *
 * WHY THIS EXISTS:
 *   When pay.html uses Razorpay's redirect/embedded mode (form POST to
 *   https://api.razorpay.com/v1/checkout/embedded), Razorpay POSTs the
 *   payment result to this URL instead of calling a JS handler.
 *   This is needed because the JS modal doesn't work properly in external
 *   Chrome browsers opened from a Median (GoNative) app.
 *
 * FLOW:
 *   pay.html (form POST) → Razorpay hosted page → this function (POST)
 *   → verify signature → activate Firestore → redirect to pay.html?status=success
 *   → pay.html shows success screen + deep links back to GuruBook app
 *
 * Add this URL in Netlify as a function and set callback_url in pay.html to:
 *   https://1gurubook.netlify.app/.netlify/functions/razorpay-callback?phone=XXX&plan=YYY
 *
 * Required env vars (same as verify-payment.js):
 *   RAZORPAY_KEY_SECRET
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY
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

// Parse application/x-www-form-urlencoded body (what Razorpay sends)
function parseFormBody(body) {
  const result = {};
  if (!body) return result;
  body.split('&').forEach(pair => {
    const [k, v] = pair.split('=');
    if (k) result[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' '));
  });
  return result;
}

exports.handler = async (event) => {
  // Razorpay POSTs form data to this URL after payment completes.
  // We only process POST — GET requests (e.g. direct browser visit) are rejected.
  if (event.httpMethod !== 'POST') {
    // Redirect to home gracefully instead of showing a raw error
    return {
      statusCode: 302,
      headers: { Location: 'https://1gurubook.netlify.app/pay.html' },
      body: ''
    };
  }

  // phone and plan come from our query string we set in the callback_url
  const phone = event.queryStringParameters?.phone || '';
  const plan  = event.queryStringParameters?.plan  || 'monthly';

  // Parse the form body from Razorpay
  const form = parseFormBody(event.body);
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature
  } = form;

  // Base URL for redirects
  const host        = event.headers['x-forwarded-host'] || event.headers.host || '1gurubook.netlify.app';
  const proto       = 'https';
  const baseUrl     = `${proto}://${host}`;
  const successUrl  = `${baseUrl}/pay.html?phone=${encodeURIComponent(phone)}&plan=${encodeURIComponent(plan)}&status=success`;
  const failUrl     = `${baseUrl}/pay.html?phone=${encodeURIComponent(phone)}&plan=${encodeURIComponent(plan)}&status=failed`;

  // ── 1. Verify Razorpay signature ─────────────────────────────────────────
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    console.error('razorpay-callback: missing payment fields', form);
    return { statusCode: 302, headers: { Location: failUrl }, body: '' };
  }

  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + '|' + razorpay_payment_id)
    .digest('hex');

  if (expectedSig !== razorpay_signature) {
    console.error('razorpay-callback: signature mismatch — possible fraud');
    return { statusCode: 302, headers: { Location: failUrl }, body: '' };
  }

  // ── 2. Look up user in Firestore by phone ────────────────────────────────
  if (!phone) {
    console.error('razorpay-callback: no phone in query params');
    return { statusCode: 302, headers: { Location: failUrl }, body: '' };
  }

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
      console.error('razorpay-callback: user not found for phone:', normalised);
      return { statusCode: 302, headers: { Location: failUrl }, body: '' };
    }

    userDocRef = snap.docs[0].ref;
  } catch (err) {
    console.error('razorpay-callback: Firestore lookup error:', err);
    return { statusCode: 302, headers: { Location: failUrl }, body: '' };
  }

  // ── 3. Idempotency + activate ─────────────────────────────────────────────
  try {
    const userDoc  = await userDocRef.get();
    const userData = userDoc.data() || {};

    if (userData.lastPaymentId === razorpay_payment_id) {
      console.log(`razorpay-callback: Payment ${razorpay_payment_id} already processed`);
      return { statusCode: 302, headers: { Location: successUrl }, body: '' };
    }

    const validPlan        = PLAN_DURATION_MS[plan] ? plan : 'monthly';
    const now              = new Date();
    const currentPaidUntil = userData.paidUntil?.toDate();
    const baseDate         = (currentPaidUntil && currentPaidUntil > now) ? currentPaidUntil : now;
    const paidUntil        = new Date(baseDate.getTime() + PLAN_DURATION_MS[validPlan]);

    await userDocRef.update({
      paidUntil:       admin.firestore.Timestamp.fromDate(paidUntil),
      status:          'paid',
      lastPaymentId:   razorpay_payment_id,
      lastPaymentPlan: validPlan,
      lastPaymentAt:   admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`razorpay-callback: Activated ${validPlan} for ${normalised} until ${paidUntil.toISOString()}`);
    return { statusCode: 302, headers: { Location: successUrl }, body: '' };

  } catch (err) {
    console.error('razorpay-callback: Firestore update error:', err);
    // Payment verified but DB write failed — redirect to success anyway
    // (webhook will catch it as backup)
    return { statusCode: 302, headers: { Location: successUrl }, body: '' };
  }
};
