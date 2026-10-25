// Tests what the server does with a call that has no caller ID, using a signed fake Twilio webhook.
//   node --env-file=.env server/scripts/test-no-caller-id.mjs [voice webhook URL]
// Default target: http://localhost:3000/twilio/voice (Programmer A's route). Needs TWILIO_AUTH_TOKEN and
// TWILIO_WEBHOOK_URL in .env (the URL A's server validates the signature against).
// Prints only PASS or FAIL lines. It never prints the auth token.
import { createHmac } from 'node:crypto';

const target = process.argv[2] ?? 'http://localhost:3000/twilio/voice';
const authToken = process.env.TWILIO_AUTH_TOKEN;
const signedUrl = process.env.TWILIO_WEBHOOK_URL;
if (!authToken || !signedUrl) {
  console.error('FAIL  TWILIO_AUTH_TOKEN and TWILIO_WEBHOOK_URL must both be set in .env');
  process.exit(1);
}

// Twilio's documented request signature: the full URL plus every POST parameter (sorted by name, name
// then value, no separators), HMAC-SHA1 with the auth token, base64. https://www.twilio.com/docs/usage/security
function sign(url, params) {
  const data = Object.keys(params).sort().reduce((text, key) => text + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

async function post(from) {
  const params = {
    CallSid: `CAtest${Date.now()}`,
    From: from,
    To: process.env.TWILIO_PHONE_NUMBER ?? '+15555550100',
    CallStatus: 'ringing',
    Direction: 'inbound',
  };
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(signedUrl, params) },
    body: new URLSearchParams(params),
  });
  return { status: response.status, body: await response.text() };
}

const rejected = (r) => r.status === 200 && /<(Reject|Hangup)\b/.test(r.body) && !/<Stream\b/.test(r.body);
const connected = (r) => r.status === 200 && /<Stream\b/.test(r.body);

const cases = [
  // Twilio shows "anonymous" for withheld caller ID (changelog, May 2023). +266696687 is the older digit placeholder.
  { from: 'anonymous', expect: 'blocked', label: 'withheld caller ID ("anonymous")' },
  { from: '+266696687', expect: 'blocked', label: 'old placeholder (+266696687)' },
  { from: '', expect: 'blocked', label: 'empty From' },
  { from: '+14155550123', expect: 'connected', label: 'normal number (must still connect)' },
];

let failed = 0;
for (const { from, expect, label } of cases) {
  let result;
  try {
    result = await post(from);
  } catch (error) {
    console.log(`FAIL  ${label}: could not reach ${target} (${error.cause?.code ?? error.message})`);
    failed++;
    continue;
  }
  const ok = expect === 'blocked' ? rejected(result) : connected(result);
  if (!ok) failed++;
  const saw = result.status !== 200 ? `HTTP ${result.status}` : connected(result) ? 'connected to the screening agent' : rejected(result) ? 'rejected' : 'something else';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: server ${saw}`);
}
process.exit(failed ? 1 : 0);
