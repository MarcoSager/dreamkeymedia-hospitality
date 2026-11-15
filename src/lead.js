// POST /api/lead handler, shared by the Worker entry (src/worker.js) and the Node tests.
//
// 1. Verifies the Turnstile token server-side.
// 2. Validates and trims input.
// 3. Upserts the contact in GoHighLevel, appends source tags, and stores
//    interest / start timing / utm / fbclid in a contact note.
// 4. Creates a "New Lead" opportunity unless the contact already has an
//    open one in the pipeline.
//
// Returns { ok: true } once the contact is saved in GHL, even if the deal
// step fails afterwards (the lead is already captured). Never echoes upstream
// errors, tokens or stack traces. Every failure logs one line:
//   lead_error <code> [detail]
// codes: missing_secret, bad_json, turnstile_rejected, invalid_input,
//        contact (fatal, 502), tags, note, deal (non-fatal, still ok:true)

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const LOCATION_ID = '5YD1qlsIQsyJOs1mZZtt';
const PIPELINE_ID = 'Dmp6dkA6P8s4O2ADDCZh';
const NEW_LEAD_STAGE_ID = '446164ba-445a-477a-9bb2-5700b7fbd17e';

const LIMITS = {
  name: 100,
  business: 150,
  email: 254,
  phone: 30,
  interest: 100,
  start: 50,
  source: 20,
  message_channel: 20,
  utm: 150,
  fbclid: 500,
};
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9\s\-().]{8,30}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function logError(code, detail) {
  if (detail === undefined) console.log('lead_error', code);
  else console.log('lead_error', code, String(detail));
}

function fail(code, status, detail) {
  logError(code, detail);
  return json({ ok: false, error: 'Could not save your details right now.' }, status);
}

// Short, single-line validation message from a GHL error response, for logs.
// GHL error bodies carry field names, never our credentials.
async function ghlMessage(res) {
  try {
    const data = await res.clone().json();
    const msg = Array.isArray(data.message) ? data.message.join('; ') : data.message || data.error || '';
    return String(msg).replace(/\s+/g, ' ').slice(0, 160);
  } catch {
    return '';
  }
}

// Normalise a phone number to E.164 where the intent is unambiguous.
// Thai local numbers: 0 + 9 digits (mobile 06/08/09) or 0 + 8 digits
// (landline 02-07) become +66 without the leading 0. Anything we cannot
// read with confidence is returned exactly as typed (trimmed).
export function normalizePhone(input) {
  const typed = typeof input === 'string' ? input.trim() : '';
  if (!typed) return '';
  const hasPlus = typed.startsWith('+');
  const digits = typed.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^[0-9]+$/.test(digits)) return typed;
  const thaiNational = /^(?:[689][0-9]{8}|[2-7][0-9]{7})$/;

  if (hasPlus) {
    // "+66 0812345678": drop the trunk 0 people often keep after +66.
    if (/^660/.test(digits) && thaiNational.test(digits.slice(3))) return `+66${digits.slice(3)}`;
    if (/^[1-9][0-9]{7,14}$/.test(digits)) return `+${digits}`;
    return typed;
  }
  if (/^0/.test(digits) && thaiNational.test(digits.slice(1))) return `+66${digits.slice(1)}`;
  if (/^66/.test(digits) && thaiNational.test(digits.slice(2))) return `+${digits}`;
  return typed;
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function ghlHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function verifyTurnstile(token, secret, ip) {
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

export async function handleLead(request, env) {
  if (!env.TURNSTILE_SECRET || !env.GHL_TOKEN) {
    const missing = [!env.TURNSTILE_SECRET && 'TURNSTILE_SECRET', !env.GHL_TOKEN && 'GHL_TOKEN'].filter(Boolean);
    return fail('missing_secret', 500, missing.join(','));
  }

  let raw;
  try {
    raw = await request.json();
  } catch {
    return fail('bad_json', 400);
  }
  if (!raw || typeof raw !== 'object') return fail('bad_json', 400);

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const turnstileOk = await verifyTurnstile(clean(raw['cf-turnstile-response'], 2048), env.TURNSTILE_SECRET, ip);
  if (!turnstileOk) {
    logError('turnstile_rejected');
    return json({ ok: false, error: 'Security check failed. Please try again.' }, 400);
  }

  const lead = {
    name: clean(raw.name, LIMITS.name),
    business: clean(raw.business, LIMITS.business),
    email: clean(raw.email, LIMITS.email).toLowerCase(),
    phone: clean(raw.phone, LIMITS.phone),
    interest: clean(raw.interest, LIMITS.interest),
    start: clean(raw.start, LIMITS.start),
    source: clean(raw.source, LIMITS.source) === 'chat' ? 'chat' : 'form',
    message_channel: clean(raw.message_channel, LIMITS.message_channel),
    fbclid: clean(raw.fbclid, LIMITS.fbclid),
  };
  for (const k of UTM_KEYS) lead[k] = clean(raw[k], LIMITS.utm);

  if (lead.email && !EMAIL_RE.test(lead.email)) lead.email = '';
  lead.phone = lead.phone && PHONE_RE.test(lead.phone) ? normalizePhone(lead.phone) : '';
  if (!lead.name || (!lead.email && !lead.phone)) {
    logError('invalid_input');
    return json({ ok: false, error: 'Please add your name and a phone number or email.' }, 400);
  }

  const headers = ghlHeaders(env.GHL_TOKEN);
  const nameParts = lead.name.split(/\s+/);

  let contactId;
  try {
    // 1. Upsert contact. Tags are added separately below because the upsert
    //    "tags" field would overwrite any tags the contact already has.
    const upsertRes = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        locationId: LOCATION_ID,
        firstName: nameParts[0],
        lastName: nameParts.slice(1).join(' ') || undefined,
        name: lead.name,
        email: lead.email || undefined,
        phone: lead.phone || undefined,
        companyName: lead.business || undefined,
        source: 'Landing page',
      }),
    });
    if (!upsertRes.ok) return fail('contact', 502, upsertRes.status);
    const upsertData = await upsertRes.json();
    contactId = upsertData && upsertData.contact && upsertData.contact.id;
    if (!contactId) return fail('contact', 502, 'no_id');
  } catch {
    return fail('contact', 502, 'exception');
  }

  // The contact is saved from here on: later failures are logged, never shown.
  try {
    // 2. Append tags (non-fatal).
    const tags = ['source-landing-page'];
    if (lead.source === 'chat') tags.push('source-landing-chat');
    const tagRes = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags }),
    });
    if (!tagRes.ok) logError('tags', tagRes.status);

    // 3. Note with interest, timing and attribution (non-fatal).
    const noteLines = [
      `Landing page lead (${lead.source})`,
      lead.interest && `Interest: ${lead.interest}`,
      lead.start && `Start timing: ${lead.start}`,
      lead.message_channel && `Channel: ${lead.message_channel}`,
      ...UTM_KEYS.map((k) => lead[k] && `${k}: ${lead[k]}`),
      lead.fbclid && `fbclid: ${lead.fbclid}`,
    ].filter(Boolean);
    const noteRes = await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: noteLines.join('\n') }),
    });
    if (!noteRes.ok) logError('note', noteRes.status);

    // 4. Skip the deal if this contact already has an open one in the pipeline.
    //    GHL documents snake_case query params for this endpoint; camelCase
    //    is tried only if GHL rejects the first form with a 422.
    const searchHeaders = { Authorization: headers.Authorization, Version: GHL_VERSION, Accept: 'application/json' };
    const searchFor = (p) => fetch(`${GHL_BASE}/opportunities/search?${new URLSearchParams(p)}`, { headers: searchHeaders });
    let searchRes = await searchFor({
      location_id: LOCATION_ID, contact_id: contactId, pipeline_id: PIPELINE_ID, status: 'open', limit: '20',
    });
    if (searchRes.status === 422) {
      logError('deal', `search_422_snake ${await ghlMessage(searchRes)}`);
      searchRes = await searchFor({
        locationId: LOCATION_ID, contactId, pipelineId: PIPELINE_ID, status: 'open', limit: '20',
      });
    }
    if (!searchRes.ok) {
      logError('deal', `search_${searchRes.status} ${await ghlMessage(searchRes)}`);
      return json({ ok: true });
    }
    const searchData = await searchRes.json();
    const hasOpenDeal = (searchData.opportunities || []).some(
      (o) => o.contactId === contactId && o.pipelineId === PIPELINE_ID && o.status === 'open'
    );

    if (!hasOpenDeal) {
      const oppRes = await fetch(`${GHL_BASE}/opportunities/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          locationId: LOCATION_ID,
          pipelineId: PIPELINE_ID,
          pipelineStageId: NEW_LEAD_STAGE_ID,
          name: lead.business || lead.name,
          status: 'open',
          contactId,
        }),
      });
      if (!oppRes.ok) logError('deal', `${oppRes.status} ${await ghlMessage(oppRes)}`);
    }

  } catch {
    logError('deal', 'exception');
  }
  return json({ ok: true });
}

export function methodNotAllowed() {
  return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST' },
  });
}
