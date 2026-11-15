// Run: node --test tests/
// Needs network: Turnstile checks hit Cloudflare's siteverify with Cloudflare's
// published dummy secrets, and the GHL failure case hits the real GHL API with
// an invalid token. No real secrets and no real leads are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const PASS_TS = '1x0000000000000000000000000000000AA'; // Cloudflare dummy: always passes
const FAIL_TS = '2x0000000000000000000000000000000AA'; // Cloudflare dummy: always fails
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const BAD_GHL = 'invalid-test-token-do-not-log';

const ASSETS = { fetch: async (req) => new Response(`ASSET ${new URL(req.url).pathname}`) };
const env = (ts, ghl) => ({ TURNSTILE_SECRET: ts, GHL_TOKEN: ghl, ASSETS });

const VALID = {
  name: 'Test Lead', business: 'Test Bar', email: 'dreamkeymediaasia@gmail.com', phone: '+66970752722',
  interest: 'Starter Package', start: 'ASAP', source: 'form', message_channel: 'whatsapp',
  utm_source: 'facebook', utm_campaign: 'test', fbclid: 'abc123', 'cf-turnstile-response': DUMMY_TOKEN,
};

function req(method, path, body) {
  return new Request(`https://example.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function call(method, path, body, e = env(PASS_TS, BAD_GHL)) {
  const res = await worker.fetch(req(method, path, body), e);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json };
}

// Records outgoing fetch URLs and console.log output during fn().
async function spy(fn) {
  const urls = []; const logs = [];
  const realFetch = globalThis.fetch; const realLog = console.log;
  globalThis.fetch = (input, init) => { urls.push(String(input.url || input)); return realFetch(input, init); };
  console.log = (...a) => logs.push(a.join(' '));
  try { return { result: await fn(), urls, logs }; }
  finally { globalThis.fetch = realFetch; console.log = realLog; }
}

// ── Routing ──
test('routing: GET / goes to ASSETS', async () => {
  const r = await call('GET', '/');
  assert.equal(r.text, 'ASSET /');
});
test('routing: other paths and /api/* siblings go to ASSETS', async () => {
  assert.equal((await call('GET', '/images/marco.jpg')).text, 'ASSET /images/marco.jpg');
  assert.equal((await call('GET', '/api/other')).text, 'ASSET /api/other');
});
test('routing: POST /api/lead reaches the handler', async () => {
  const r = await call('POST', '/api/lead', VALID, env('', ''));
  assert.equal(r.status, 500);
  assert.equal(r.json.ok, false);
});
test('routing: GET and PUT /api/lead give 405', async () => {
  assert.equal((await call('GET', '/api/lead')).status, 405);
  assert.equal((await call('PUT', '/api/lead', {})).status, 405);
});

// ── Handler ──
test('invalid Turnstile -> 400 and GHL is never called', async () => {
  const { result, urls } = await spy(() => call('POST', '/api/lead', VALID, env(FAIL_TS, BAD_GHL)));
  assert.equal(result.status, 400);
  assert.equal(result.json.ok, false);
  assert.ok(!urls.some((u) => u.includes('leadconnectorhq.com')), 'no GHL calls expected');
});
test('missing Turnstile token -> 400', async () => {
  const r = await call('POST', '/api/lead', { name: 'Test Lead', phone: '+66970752722' });
  assert.equal(r.status, 400);
});
test('bad JSON -> 400', async () => {
  assert.equal((await call('POST', '/api/lead', 'not-json')).status, 400);
});
for (const [label, body] of [
  ['no name', { phone: '+66970752722' }],
  ['name only', { name: 'Test Lead' }],
  ['name + invalid email', { name: 'Test Lead', email: 'not-an-email' }],
  ['name + invalid phone', { name: 'Test Lead', phone: '12' }],
]) {
  test(`invalid input (${label}) -> 400`, async () => {
    const r = await call('POST', '/api/lead', { ...body, 'cf-turnstile-response': DUMMY_TOKEN });
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
  });
}
test('GHL failure -> 502 generic message, token never logged or returned', async () => {
  const { result, logs } = await spy(() => call('POST', '/api/lead', VALID, env(PASS_TS, BAD_GHL)));
  assert.equal(result.status, 502);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error, 'Could not save your details right now.');
  assert.ok(!result.text.includes(BAD_GHL));
  assert.ok(!logs.join('\n').includes(BAD_GHL));
  assert.ok(logs.includes('lead_error ghl_upsert_401'), `logs: ${logs}`);
});
test('missing env vars -> 500', async () => {
  const r = await call('POST', '/api/lead', VALID, env('', ''));
  assert.equal(r.status, 500);
});
