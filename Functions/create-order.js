/**
 * Netlify Function — create-order.js
 *
 * Creates a Razorpay order server-side so the Key Secret never
 * reaches the browser. Called by _rzpStartPayment() in the app.
 *
 * Required env vars (set in Netlify → Site → Environment Variables):
 *   RAZORPAY_KEY_ID      = rzp_live_xxxxxxxxxxxx
 *   RAZORPAY_KEY_SECRET  = your_key_secret_here
 */

const Razorpay = require('razorpay');

// Price map — amounts in paise (₹1 = 100 paise)
const PLANS = {
  monthly: { amount: 34900,  label: 'My Institute — Monthly Plan (₹349/month)' },
  yearly:  { amount: 198000, label: 'My Institute — Yearly Plan (₹1,980/year)' }
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let plan, deviceId;
  try {
    ({ plan, deviceId } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!PLANS[plan]) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid plan. Must be "monthly" or "yearly".' }) };
  }
  if (!deviceId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'deviceId is required' }) };
  }

  const razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });

  try {
    const order = await razorpay.orders.create({
      amount:   PLANS[plan].amount,
      currency: 'INR',
      receipt:  `mi_${plan}_${deviceId.slice(-8)}_${Date.now()}`,
      notes: {
        deviceId,
        plan,
        description: PLANS[plan].label
      }
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId:  order.id,
        amount:   order.amount,
        currency: order.currency,
        keyId:    process.env.RAZORPAY_KEY_ID
      })
    };
  } catch (err) {
    console.error('Razorpay order creation error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Could not create payment order. Please try again.' })
    };
  }
};
