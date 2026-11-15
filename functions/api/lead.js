// Cloudflare Pages Function: POST /api/lead
//
// Verifies the Turnstile token server-side, upserts the lead into
// GoHighLevel (contact + tag + note), and creates a "New Lead"
// opportunity unless one is already open for this contact in the
// pipeline. Returns { ok: true } only once the contact is actually
// saved in GHL. Never logs or returns secret values.

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const LOCATION_ID = '5YD1qlsIQsyJOs1mZZtt';
const PIPELINE_ID = 'Dmp6dkA6P8s4O2ADDCZh';
const NEW_LEAD_STAGE_ID = '446164ba-445a-477a-9bb2-5700b7fbd17e';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ghlHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    'Content-Type': 'application/json',
  };
}

async function verifyTurnstile(token, secret, ip) {
  if (!token || !secret) return false;
  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);

  let res;
  try {
    res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    return false;
  }
  if (!res.ok) return false;
  const data = await res.json().catch(() => null);
  return !!(data && data.success);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_request' }, 400);
  }

  if (!env.TURNSTILE_SECRET || !env.GHL_TOKEN) {
    return json({ ok: false, error: 'server_misconfigured' }, 500);
  }

  const turnstileToken = payload.turnstileToken || '';
  const clientIp = request.headers.get('CF-Connecting-IP') || undefined;

  const verified = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, clientIp);
  if (!verified) {
    return json({ ok: false, error: 'turnstile_failed' }, 403);
  }

  const name = String(payload.name || '').trim();
  const business = String(payload.business || '').trim();
  const email = String(payload.email || '').trim();
  const phone = String(payload.phone || '').trim();
  const interest = String(payload.interest || '');
  const start = String(payload.start || '');
  const utm = payload.utm && typeof payload.utm === 'object' ? payload.utm : {};
  const fbclid = String(payload.fbclid || '');

  if (!name && !email && !phone) {
    return json({ ok: false, error: 'missing_identity' }, 400);
  }

  const nameParts = name.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ');

  try {
    // 1. Upsert the contact.
    const upsertRes = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: 'POST',
      headers: ghlHeaders(env.GHL_TOKEN),
      body: JSON.stringify({
        locationId: LOCATION_ID,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        name: name || undefined,
        email: email || undefined,
        phone: phone || undefined,
        companyName: business || undefined,
        tags: ['source-landing-page'],
        source: 'landing-page',
      }),
    });

    if (!upsertRes.ok) {
      return json({ ok: false, error: 'ghl_contact_failed' }, 502);
    }
    const upsertData = await upsertRes.json().catch(() => null);
    const contactId = upsertData && upsertData.contact && upsertData.contact.id;
    if (!contactId) {
      return json({ ok: false, error: 'ghl_contact_missing_id' }, 502);
    }

    // 2. Check for an existing open opportunity in this pipeline before creating a new one.
    let hasOpenOpportunity = false;
    try {
      const searchRes = await fetch(`${GHL_BASE}/opportunities/search`, {
        method: 'POST',
        headers: ghlHeaders(env.GHL_TOKEN),
        body: JSON.stringify({
          locationId: LOCATION_ID,
          limit: 1,
          filters: [
            { field: 'contactId', operator: 'eq', value: contactId },
            { field: 'pipelineId', operator: 'eq', value: PIPELINE_ID },
            { field: 'status', operator: 'eq', value: 'open' },
          ],
        }),
      });
      if (searchRes.ok) {
        const searchData = await searchRes.json().catch(() => null);
        hasOpenOpportunity = !!(
          searchData &&
          Array.isArray(searchData.opportunities) &&
          searchData.opportunities.length > 0
        );
      }
    } catch {
      // Best-effort dedupe check — if it fails, fall through and still try to create.
    }

    if (!hasOpenOpportunity) {
      await fetch(`${GHL_BASE}/opportunities/`, {
        method: 'POST',
        headers: ghlHeaders(env.GHL_TOKEN),
        body: JSON.stringify({
          locationId: LOCATION_ID,
          pipelineId: PIPELINE_ID,
          pipelineStageId: NEW_LEAD_STAGE_ID,
          name: business || name || 'New Lead',
          status: 'open',
          contactId,
        }),
      }).catch(() => {});
      // Non-fatal: the contact is already saved even if opportunity creation fails.
    }

    // 3. Store interest / start timing / utm / fbclid as a note (best-effort, non-fatal).
    const noteLines = [
      interest ? `Interest: ${interest}` : null,
      start ? `Start timing: ${start}` : null,
      fbclid ? `fbclid: ${fbclid}` : null,
      ...Object.entries(utm)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`),
    ].filter(Boolean);

    if (noteLines.length) {
      await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
        method: 'POST',
        headers: ghlHeaders(env.GHL_TOKEN),
        body: JSON.stringify({
          title: 'Landing page lead details',
          body: noteLines.join('\n'),
        }),
      }).catch(() => {});
    }

    return json({ ok: true });
  } catch {
    return json({ ok: false, error: 'server_error' }, 500);
  }
}

export async function onRequestGet() {
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}
