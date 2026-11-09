import { createHmac, timingSafeEqual } from 'node:crypto';
import { Problem } from './store.js';

export function sign(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  return 't=' + timestamp + ',v1=' + createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex');
}

export function verify(body, signature, secret) {
  const parts = (signature ?? '').split(',');
  const timestamp = parts.find(part => part.startsWith('t='))?.slice(2);
  if (!/^\d{1,12}$/.test(timestamp ?? '') || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    throw new Problem(401, 'Missing or stale webhook timestamp');
  }
  const expected = Buffer.from(sign(body, secret, timestamp).split('v1=')[1], 'hex');
  const valid = parts.some(part => /^v1=[0-9a-f]{64}$/i.test(part) &&
    timingSafeEqual(Buffer.from(part.slice(3), 'hex'), expected));
  if (!valid) throw new Problem(401, 'Invalid webhook signature');
}

export async function stripeCheckout(payment, secret, origin, request = fetch) {
  if (Date.now() - payment.created_at > 23 * 60 * 60 * 1000) {
    throw new Problem(409, 'Checkout retry window expired. Investigate the existing payment before starting another.');
  }
  const params = new URLSearchParams({
    mode: 'payment',
    'payment_method_types[0]': 'card',
    'line_items[0][price_data][currency]': payment.currency,
    'line_items[0][price_data][unit_amount]': String(payment.amount),
    'line_items[0][price_data][product_data][name]': 'Clearinghouse Lab test purchase',
    'line_items[0][quantity]': '1',
    'metadata[payment_id]': payment.id,
    success_url: origin + '/?payment=' + payment.id,
    cancel_url: origin + '/?payment=' + payment.id
  });
  let response;
  try {
    response = await request('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + secret, 'Idempotency-Key': 'clearinghouse-' + payment.id },
      body: params,
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new Problem(502, 'Stripe checkout request failed. Retry with the same key.');
  }
  if (!response.ok) throw new Problem(502, 'Stripe checkout unavailable. Retry with the same key.');
  const session = await response.json();
  if (session.livemode !== false || typeof session.id !== 'string' || !session.id.startsWith('cs_test_')) {
    throw new Problem(502, 'Unexpected Stripe checkout response');
  }
  return session.url;
}

export function stripeCapture(event) {
  const session = event?.data?.object;
  if (event?.livemode !== false || event.type !== 'checkout.session.completed' ||
      session?.mode !== 'payment' || session.payment_status !== 'paid') return null;
  if (typeof session.payment_intent !== 'string' || !session.payment_intent.startsWith('pi_')) {
    throw new Problem(422, 'Expected a Stripe PaymentIntent reference');
  }
  return {
    provider: 'stripe', eventId: event.id, paymentId: session.metadata?.payment_id,
    ref: session.payment_intent, amount: session.amount_total, currency: session.currency
  };
}
