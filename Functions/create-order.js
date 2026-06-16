/**
 * Netlify Function — create-order.js
 * FIXED: now accepts `phone` (sent by pay.html) instead of `deviceId`
 *
 * Required env vars:
 *   RAZORPAY_KEY_ID      = rzp_test_xxxxxxxxxxxx  (or rzp_live_...)
 *   RAZORPAY_KEY_SECRET  = your_key_secret_here
 */

const Razorpay = require('razorpay');

// Price map — amounts in paise (₹1 = 100 paise)
const PLANS = {
  monthly: { amount: 34900,  label: 'GuruBook — Monthly Plan (₹349/month)' },
  yearly:  { amount: 198000, label: 'GuruBook — Yearly Plan (₹1,980/year)' }
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let plan, phone;
  try {
    ({ plan, phone } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!PLANS[plan]) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid plan. Must be "monthly" or "yearly".' }) };
  }
  if (!phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'phone is required' }) };
  }

  const normalised = phone.replace(/\D/g, '').slice(-10);

  const razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });

  try {
    const order = await razorpay.orders.create({
      amount:   PLANS[plan].amount,
      currency: 'INR',
      receipt:  `gb_${plan}_${normalised.slice(-6)}_${Date.now()}`,
      notes: {
        phone:       normalised,
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
