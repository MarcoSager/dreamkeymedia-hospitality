// POST /api/lead handler, shared by the Worker entry (src/worker.js) and the Node tests.
//
// 1. Verifies the Turnstile token server-side.
// 2. Validates and trims input.
// 3. Upserts the contact in GoHighLevel, appends source tags, and stores
//    interest / start timing / utm / fbclid in a contact note.
// 4. Creates a "New Lead" opportunity unless the contact already has an
//    open one in the pipeline.
//
// Returns { ok: true } once the contact is saved in GHL. Never echoes
// upstream errors, tokens or stack traces; logs only short error codes.

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

function fail(code, status) {
  console.log('lead_error', code);
  return json({ ok: false, error: 'Could not save your details right now.' }, status);
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
  if (!env.TURNSTILE_SECRET || !env.GHL_TOKEN) return fail('missing_env', 500);

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
    console.log('lead_error', 'turnstile_invalid');
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
  if (lead.phone && !PHONE_RE.test(lead.phone)) lead.phone = '';
  if (!lead.name || (!lead.email && !lead.phone)) {
    console.log('lead_error', 'invalid_input');
    return json({ ok: false, error: 'Please add your name and a phone number or email.' }, 400);
  }

  const headers = ghlHeaders(env.GHL_TOKEN);
  const nameParts = lead.name.split(/\s+/);

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
    if (!upsertRes.ok) return fail(`ghl_upsert_${upsertRes.status}`, 502);
    const upsertData = await upsertRes.json();
    const contactId = upsertData && upsertData.contact && upsertData.contact.id;
    if (!contactId) return fail('ghl_upsert_no_id', 502);

    // 2. Append tags (non-fatal).
    const tags = ['source-landing-page'];
    if (lead.source === 'chat') tags.push('source-landing-chat');
    const tagRes = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tags }),
    });
    if (!tagRes.ok) console.log('lead_error', `ghl_tags_${tagRes.status}`);

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
    if (!noteRes.ok) console.log('lead_error', `ghl_note_${noteRes.status}`);

    // 4. Skip the deal if this contact already has an open one in the pipeline.
    const search = new URLSearchParams({
      locationId: LOCATION_ID,
      contactId,
      pipelineId: PIPELINE_ID,
      status: 'open',
      limit: '20',
    });
    const searchRes = await fetch(`${GHL_BASE}/opportunities/search?${search}`, { headers });
    if (!searchRes.ok) return fail(`ghl_search_${searchRes.status}`, 502);
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
      if (!oppRes.ok) return fail(`ghl_opportunity_${oppRes.status}`, 502);
    }

    return json({ ok: true });
  } catch {
    return fail('exception', 502);
  }
}

export function methodNotAllowed() {
  return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST' },
  });
}
