# Contact form setup

The contact and lead-generation forms post to `/api/contact`, handled by the
site's Cloudflare Worker. It verifies a Turnstile token and sends the submission
by email through Resend.

The site is a **Worker with static assets** (not Pages), deployed by Workers
Builds running `npx wrangler deploy` against the connected GitHub repo. The
Worker serves `/api/contact`; every other path comes straight from the asset
store.

| Piece | File |
| --- | --- |
| Worker + form handler | [`src/index.js`](src/index.js) |
| Browser submit | [`js/forms.js`](js/forms.js) |
| Forms | [`contact-us.html`](contact-us.html), [`lead-generation-form.html`](lead-generation-form.html) |

Both forms carry `action="/api/contact"` and a `data-form` value (`contact` or
`lead`) that selects the required-field set and subject line in the handler.

## What still needs doing before go-live

The form works as shipped, but on placeholder credentials. Two things must be
replaced:

### 1. Verify `telsalighting.com` in Resend

Submissions currently send from `onboarding@resend.dev`, Resend's shared test
sender. **It only delivers to the email address that owns the Resend account** —
it will not reach `sales@telsalighting.com`.

1. Resend dashboard → **Domains** → **Add Domain** → `telsalighting.com`.
2. Add the DKIM, SPF and (optional) DMARC records Resend shows you to the
   `telsalighting.com` DNS zone. If DNS is on Cloudflare, set those records to
   **DNS only** (grey cloud).
3. Wait for the domain to show **Verified**.
4. Set `CONTACT_FROM` to an address on that domain, e.g.
   `Telsa Lighting Website <forms@telsalighting.com>`.

### 2. Issue real Turnstile keys

The forms ship with Cloudflare's documented "always passes" test keys, so spam
protection is effectively off until you swap them.

1. Cloudflare dashboard → **Turnstile** → **Add widget**, hostname
   `telsalighting.com`.
2. Put the **site key** in the `data-sitekey` attribute of the
   `.cf-turnstile` div on both form pages, replacing `1x00000000000000000000AA`.
3. Put the **secret key** in the `TURNSTILE_SECRET_KEY` secret below.

## Environment variables

Set these in the Cloudflare dashboard under **Workers & Pages → telsa-lighting
→ Settings → Variables and Secrets**.

| Name | Type | Value |
| --- | --- | --- |
| `RESEND_API_KEY` | Secret | Resend API key, **Sending access**, restricted to `telsalighting.com` |
| `TURNSTILE_SECRET_KEY` | Secret | Turnstile secret key |
| `CONTACT_TO` | Plaintext | `sales@telsalighting.com` — set in `wrangler.jsonc` under `vars`, not the dashboard |
| `CONTACT_FROM` | Plaintext | `Telsa Lighting Website <forms@telsalighting.com>` |

`CONTACT_TO` and `CONTACT_FROM` have defaults in the handler, so only the two
secrets are strictly required — but leaving `CONTACT_FROM` unset means mail goes
out from the Resend test sender and will not arrive.

## Local development

```bash
npx wrangler dev
```

Put local values in `.dev.vars` at the repo root (git-ignored):

```
RESEND_API_KEY=re_...
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
CONTACT_TO=you@example.com
CONTACT_FROM=onboarding@resend.dev
```

With the test Turnstile secret and `onboarding@resend.dev`, mail is delivered to
whichever address owns the Resend account.

**Known caveat:** because `assets.directory` is the repo root, `wrangler dev`
watches the whole project — including the `.wrangler/` state directory it writes
itself — and hot-reloads in a loop. GET requests still work, but POSTs get cut
off mid-request. To test the form end to end, either deploy to a preview URL, or
move the static site into a `public/` subdirectory (see below).

## Behaviour

- **Validation** happens on both sides. The browser enforces the `required`
  attributes; the handler re-checks required fields and email format, because a
  bot posting directly to `/api/contact` never runs the browser checks.
- **Spam** is filtered by Turnstile plus a hidden `company-website` honeypot
  field. A filled honeypot returns a success response without sending anything,
  so the bot gets no signal to tune against.
- **Replies** work directly — the notification email sets `reply_to` to the
  submitter's address.
- **Attachments** (lead-generation form only) are capped at 5 files and 10MB
  total, images and PDF only. Adjust in the `ATTACHMENTS` object in the handler.
  Resend's own ceiling is 40MB per message.
- **Failures** never leak internals. Resend's error body is written to the tail
  log (`npx wrangler pages deployment tail`) and the visitor sees a generic
  message in the existing `.w-form-fail` block.

## Free-tier limits

Resend's free tier allows 100 emails/day and 3,000/month, which covers lead
volume comfortably. Turnstile is free and unmetered.

## What is excluded from the public site

[`.assetsignore`](.assetsignore) controls what `wrangler deploy` uploads. Without
it, `assets.directory: "./"` publishes the **entire repo directory**, `.git`
included — which made the full commit history downloadable from
`/.git/objects/pack/...`. Keep `.git`, `src`, `.dev.vars` and `wrangler.jsonc` in
that file.

A sturdier long-term fix is to move the static site (`*.html`, `css/`, `js/`,
`images/`, `fonts/`) into a `public/` subdirectory and point
`assets.directory` at it. Then nothing outside `public/` can ever be published
by accident, and the `wrangler dev` reload loop goes away. It is a large file
move, so it has been left as a separate decision.

## Not covered by this change

The newsletter subscription forms in the footer of every page still post to
`server.konsist.co/.../subscribe.php` and are unaffected. If the plan is to move
marketing email to Resend too, those would be repointed at a second Pages
Function that calls Resend's Contacts API against an Audience.
