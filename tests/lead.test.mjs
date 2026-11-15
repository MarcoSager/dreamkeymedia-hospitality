// Run: node --test tests/lead.test.mjs
// Needs network: Turnstile checks hit Cloudflare's siteverify with Cloudflare's
// published dummy secrets, and the GHL failure case hits the real GHL API with
// an invalid token. No real secrets and no real leads are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { normalizePhone } from '../src/lead.js';

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
  assert.ok(logs.includes('lead_error contact 401'), `logs: ${logs}`);
});
test('missing secrets -> 500 and logs lead_error missing_secret with names only', async () => {
  const { result, logs } = await spy(() => call('POST', '/api/lead', VALID, env('', '')));
  assert.equal(result.status, 500);
  assert.ok(logs.includes('lead_error missing_secret TURNSTILE_SECRET,GHL_TOKEN'), `logs: ${logs}`);
  const half = await spy(() => call('POST', '/api/lead', VALID, env(PASS_TS, '')));
  assert.ok(half.logs.includes('lead_error missing_secret GHL_TOKEN'), `logs: ${half.logs}`);
});
test('Turnstile rejected -> logs lead_error turnstile_rejected', async () => {
  const { logs } = await spy(() => call('POST', '/api/lead', VALID, env(FAIL_TS, BAD_GHL)));
  assert.ok(logs.includes('lead_error turnstile_rejected'), `logs: ${logs}`);
});

// ── Phone normalisation (E.164) ──
for (const [input, expected] of [
  ['0970752722', '+66970752722'],          // Thai mobile, local format
  ['097-075-2722', '+66970752722'],        // with dashes
  ['097 075 2722', '+66970752722'],        // with spaces
  ['081 234 5678', '+66812345678'],
  ['061-234-5678', '+66612345678'],
  ['02 123 4567', '+6621234567'],          // Bangkok landline
  ['(053) 123-456', '+6653123456'],        // Chiang Mai landline
  ['+66970752722', '+66970752722'],        // already E.164
  ['+66 97 075 2722', '+66970752722'],
  ['+66 0970752722', '+66970752722'],      // trunk 0 kept after +66
  ['66970752722', '+66970752722'],         // country code without +
  ['+44 20 7946 0958', '+442079460958'],   // foreign, explicit +
  ['+1 (415) 555-0100', '+14155550100'],
  ['0012025550100', '0012025550100'],      // intl dial prefix: ambiguous, as typed
  ['097075272', '097075272'],              // mobile prefix, 1 digit short: as typed
  ['4155550100', '4155550100'],            // no country code: as typed
  ['  0970752722  ', '+66970752722'],
]) {
  test(`normalizePhone(${JSON.stringify(input)}) -> ${expected}`, () => {
    assert.equal(normalizePhone(input), expected);
  });
}

// ── Mocked GHL: deal and contact failure paths (no network) ──
// Fakes siteverify and every GHL endpoint. `status` overrides per step.
async function mocked(status = {}, body = VALID) {
  const calls = []; const logs = [];
  const realFetch = globalThis.fetch; const realLog = console.log;
  const reply = (code, data) => new Response(JSON.stringify(data), { status: code, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input.url || input);
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null });
    if (url.includes('siteverify')) return reply(200, { success: true });
    if (url.endsWith('/contacts/upsert')) return reply(status.upsert || 200, { contact: { id: 'c1' } });
    if (url.endsWith('/tags')) return reply(status.tags || 201, {});
    if (url.endsWith('/notes')) return reply(status.note || 201, {});
    if (url.includes('/opportunities/search')) return reply(status.search || 200, { opportunities: status.openDeal ? [{ contactId: 'c1', pipelineId: 'Dmp6dkA6P8s4O2ADDCZh', status: 'open' }] : [] });
    if (url.endsWith('/opportunities/') && method === 'POST') return reply(status.deal || 201, {});
    throw new Error(`unexpected fetch ${url}`);
  };
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const res = await worker.fetch(req('POST', '/api/lead', body), env(PASS_TS, 'mock-token-do-not-log'));
    return { status: res.status, json: await res.json(), calls, logs };
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
}

test('happy path -> ok:true, one deal created, no errors logged', async () => {
  const r = await mocked();
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.calls.filter((c) => c.url.endsWith('/opportunities/') && c.method === 'POST').length, 1);
  assert.deepEqual(r.logs, []);
});
test('existing open deal -> ok:true, no new deal', async () => {
  const r = await mocked({ openDeal: true });
  assert.equal(r.json.ok, true);
  assert.equal(r.calls.filter((c) => c.url.endsWith('/opportunities/') && c.method === 'POST').length, 0);
});
test('contact saved but deal creation fails -> 200 ok:true and logs lead_error deal', async () => {
  const r = await mocked({ deal: 500 });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.logs.includes('lead_error deal 500'), `logs: ${r.logs}`);
  assert.ok(!r.logs.join('\n').includes('mock-token-do-not-log'));
});
test('contact saved but deal search fails -> ok:true and logs lead_error deal', async () => {
  const r = await mocked({ search: 503 });
  assert.equal(r.json.ok, true);
  assert.ok(r.logs.includes('lead_error deal search_503'), `logs: ${r.logs}`);
});
test('GHL contact fails -> 502 ok:false, logs lead_error contact, no deal attempted', async () => {
  const r = await mocked({ upsert: 422 });
  assert.equal(r.status, 502);
  assert.equal(r.json.ok, false);
  assert.ok(r.logs.includes('lead_error contact 422'), `logs: ${r.logs}`);
  assert.ok(!r.calls.some((c) => c.url.includes('/opportunities')));
});
test('local Thai phone is sent to GHL as E.164', async () => {
  const r = await mocked({}, { ...VALID, phone: '097-075-2722' });
  const upsert = r.calls.find((c) => c.url.endsWith('/contacts/upsert'));
  assert.equal(upsert.body.phone, '+66970752722');
});
