/**
 * Worker entrypoint for the telsa-lighting site.
 *
 * Everything except /api/contact is served from the static assets binding.
 * /api/contact replaces the Webflow-hosted form endpoint that stopped working
 * once the site was exported: it verifies a Cloudflare Turnstile token, then
 * delivers the submission by email through Resend.
 *
 * Bindings (Workers & Pages > telsa-lighting > Settings > Variables and Secrets):
 *   RESEND_API_KEY        secret   required
 *   TURNSTILE_SECRET_KEY  secret   required in production, see TURNSTILE_TEST_SECRET
 *   CONTACT_TO            plain    where submissions are delivered
 *   CONTACT_FROM          plain    verified Resend sender, "Name <addr@domain>"
 */

const DEFAULTS = {
  CONTACT_TO: 'sales@telsalighting.com',
  // onboarding@resend.dev is Resend's shared test sender. It only ever delivers
  // to the address that owns the Resend account. Set CONTACT_FROM to an address
  // on a domain verified in Resend before going live.
  CONTACT_FROM: 'Telsa Lighting Website <onboarding@resend.dev>',
};

// Cloudflare's documented "always passes" Turnstile secret. Used only when no
// TURNSTILE_SECRET_KEY is configured, so the form works before keys are issued.
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

const FORMS = {
  contact: {
    subject: 'New contact enquiry',
    required: ['Interested-in', 'name', 'Phone', 'Email', 'Message'],
  },
  lead: {
    subject: 'New lead generation enquiry',
    required: ['name', 'Phone', 'Email', 'Interested-in', 'Project-Name', 'Project-Destinatiom'],
  },
};

const FIELD_LABELS = {
  'Interested-in': 'Interested in',
  name: 'Name',
  Phone: 'Phone',
  Email: 'Email',
  Message: 'Message',
  'Project-Name': 'Project title',
  // Field name is misspelled in the Webflow markup; kept as-is so the export
  // and this handler stay in sync.
  'Project-Destinatiom': 'Project destination',
  'Delivery-Date': 'Required delivery date',
  'Delivery-Address': 'Destination address',
  'Brand-Name': 'Brand name',
  'Model-Number': 'Model number',
  'Serial-Number': 'Serial number',
  Width: 'Width',
  Height: 'Height',
  Depth: 'Depth',
  'Performance-Requirements': 'Performance requirements',
};

// Field order in the email. Anything not listed is appended alphabetically.
const FIELD_ORDER = Object.keys(FIELD_LABELS);

// Not rendered into the email body.
const RESERVED_FIELDS = new Set(['form', 'cf-turnstile-response', 'company-website']);

const ATTACHMENTS = {
  field: 'images',
  maxFiles: 5,
  maxTotalBytes: 10 * 1024 * 1024,
  allowedTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'application/pdf'],
};

const MAX_FIELD_LENGTH = 5000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'Method not allowed.' }, 405, { Allow: 'POST' });
      }
      return handleContact(request, env);
    }

    // Everything else is a static asset. run_worker_first in wrangler.jsonc
    // keeps this path off the hot path for normal page loads.
    return env.ASSETS.fetch(request);
  },
};

export async function handleContact(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'Could not read the submitted form.' }, 400);
  }

  // Honeypot. Bots fill every field they find; humans never see this one.
  // Answer with a success so the bot has no signal to tune against.
  if ((form.get('company-website') || '').toString().trim() !== '') {
    return json({ ok: true });
  }

  const formKey = (form.get('form') || 'contact').toString();
  const config = FORMS[formKey];
  if (!config) {
    return json({ ok: false, error: 'Unknown form.' }, 400);
  }

  if (!env.TURNSTILE_SECRET_KEY) {
    // The fallback below accepts any token, so spam protection is effectively
    // off. Fine locally, never fine in production -- make it visible in the log
    // rather than failing open in silence.
    console.warn('TURNSTILE_SECRET_KEY is not set; falling back to the always-passes test secret.');
  }

  const turnstile = await verifyTurnstile(
    (form.get('cf-turnstile-response') || '').toString(),
    request.headers.get('CF-Connecting-IP'),
    env.TURNSTILE_SECRET_KEY || TURNSTILE_TEST_SECRET
  );
  if (!turnstile) {
    return json({ ok: false, error: 'Could not verify that you are human. Please try again.' }, 400);
  }

  const fields = collectFields(form);

  const missing = config.required.filter((key) => !fields[key]);
  if (missing.length) {
    const names = missing.map((key) => FIELD_LABELS[key] || key);
    return json({ ok: false, error: `Please fill out: ${names.join(', ')}.` }, 400);
  }

  if (!isEmail(fields.Email)) {
    return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  }

  if (!env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not configured.');
    return json({ ok: false, error: 'The form is not configured correctly. Please email us directly.' }, 500);
  }

  let attachments;
  try {
    attachments = await collectAttachments(form);
  } catch (err) {
    return json({ ok: false, error: err.message }, 400);
  }

  const submittedFrom = request.headers.get('Referer') || '';
  const payload = {
    from: env.CONTACT_FROM || DEFAULTS.CONTACT_FROM,
    to: [env.CONTACT_TO || DEFAULTS.CONTACT_TO],
    reply_to: fields.Email,
    subject: `${config.subject} — ${fields.name}`,
    text: textBody(fields, attachments, submittedFrom),
    html: htmlBody(fields, attachments, submittedFrom),
  };
  if (attachments.length) {
    payload.attachments = attachments.map((file) => ({ filename: file.filename, content: file.content }));
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    // Body may carry the reason (unverified domain, quota, bad key). It is
    // useful in the tail log but must not reach the visitor.
    console.error('Resend rejected the send', response.status, await response.text());
    return json({ ok: false, error: 'We could not send your message. Please try again or email us directly.' }, 502);
  }

  return json({ ok: true });
}

async function verifyTurnstile(token, ip, secret) {
  if (!token) return false;

  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const result = await res.json();
    if (!result.success) {
      console.warn('Turnstile rejected a submission', result['error-codes']);
    }
    return result.success === true;
  } catch (err) {
    console.error('Turnstile verification failed', err);
    return false;
  }
}

function collectFields(form) {
  const fields = {};
  for (const [key, value] of form.entries()) {
    if (RESERVED_FIELDS.has(key) || key === ATTACHMENTS.field) continue;
    if (typeof value !== 'string') continue;
    // multipart/form-data normalises line endings to CRLF; collapse them so
    // the newline-to-<br> pass in htmlBody does not leave stray carriage returns.
    const trimmed = value.replace(/\r\n/g, '\n').trim().slice(0, MAX_FIELD_LENGTH);
    if (trimmed) fields[key] = trimmed;
  }
  return fields;
}

async function collectAttachments(form) {
  const files = form.getAll(ATTACHMENTS.field).filter((file) => file && typeof file === 'object' && file.size > 0);
  if (!files.length) return [];

  if (files.length > ATTACHMENTS.maxFiles) {
    throw new Error(`Please attach no more than ${ATTACHMENTS.maxFiles} images.`);
  }

  let total = 0;
  const collected = [];
  for (const file of files) {
    if (!ATTACHMENTS.allowedTypes.includes(file.type)) {
      throw new Error(`"${file.name}" is not a supported file type. Please attach images or a PDF.`);
    }
    total += file.size;
    if (total > ATTACHMENTS.maxTotalBytes) {
      throw new Error(`Attachments must total less than ${Math.round(ATTACHMENTS.maxTotalBytes / 1024 / 1024)}MB.`);
    }
    collected.push({
      filename: file.name,
      size: file.size,
      content: toBase64(await file.arrayBuffer()),
    });
  }
  return collected;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  // btoa needs a binary string; build it in chunks so a large file does not
  // blow the argument limit on String.fromCharCode.
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function orderedEntries(fields) {
  const known = FIELD_ORDER.filter((key) => fields[key]);
  const extra = Object.keys(fields).filter((key) => !FIELD_LABELS[key]).sort();
  return [...known, ...extra].map((key) => [FIELD_LABELS[key] || key, fields[key]]);
}

function textBody(fields, attachments, source) {
  const lines = orderedEntries(fields).map(([label, value]) => `${label}: ${value}`);
  if (attachments.length) {
    lines.push('', `Attachments: ${attachments.map((f) => f.filename).join(', ')}`);
  }
  if (source) lines.push('', `Submitted from: ${source}`);
  return lines.join('\n');
}

function htmlBody(fields, attachments, source) {
  const rows = orderedEntries(fields)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:8px 16px 8px 0;vertical-align:top;color:#6b7280;white-space:nowrap">${escapeHtml(
          label
        )}</td><td style="padding:8px 0;vertical-align:top;color:#172a48">${escapeHtml(value).replace(
          /\n/g,
          '<br>'
        )}</td></tr>`
    )
    .join('');

  const footerParts = [];
  if (attachments.length) {
    footerParts.push(`${attachments.length} attachment(s): ${escapeHtml(attachments.map((f) => f.filename).join(', '))}`);
  }
  if (source) footerParts.push(`Submitted from ${escapeHtml(source)}`);
  const footer = footerParts.length
    ? `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">${footerParts.join('<br>')}</p>`
    : '';

  return `<div style="font-family:Montserrat,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">
  <table style="border-collapse:collapse">${rows}</table>
  ${footer}
</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || '');
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
