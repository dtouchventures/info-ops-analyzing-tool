# Security and data handling

## Access control

| Area | How it works |
|---|---|
| Roles | Administrator, Reviewer, Analyst, Viewer. The permission matrix is in `server/lib/auth.js` and shown under Administration → Permissions. |
| Case ownership | Analysts can change only cases they created or are assigned to. Reviewers and administrators can change any case. |
| Separation of duties | The person assigned to a case, or who submitted it, cannot approve it. This is enforced on the server (`ALLOW_SELF_APPROVAL=false`). |
| Locking | Cases lock while awaiting approval and after approval. A change after approval opens a new revision; the approved report stays frozen. |
| Passwords | scrypt (N=16384) with a random salt. Minimum 12 characters including letters and numbers. Temporary passwords must be changed at first sign-in. Five failed attempts per user and IP address block sign-in for 15 minutes. |
| Sessions | 256-bit random tokens; only their SHA-256 is stored. Cookies are `HttpOnly`, `SameSite=Strict` and `Secure` when `COOKIE_SECURE=true`. Sessions expire after `SESSION_HOURS`, and end when the account is disabled or its role changes. |

## Request protection

| Protection | Detail |
|---|---|
| CSRF | Every state-changing API call needs the `X-AIVS: 1` header (forms cannot set it), a matching `Origin`, and a SameSite=Strict cookie. |
| Headers | CSP: `default-src 'self'`, no inline script, `frame-ancestors 'none'`. Also `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive Permissions-Policy, and HSTS when the server runs over HTTPS. |
| Uploads | The file type is identified from its bytes; the name and browser MIME type are ignored. Size limit `MAX_UPLOAD_MB`. Images are decoded by libvips with a pixel limit. Media is served with `Content-Security-Policy: sandbox` and `nosniff`. |
| Errors | The API never returns stack traces. |

## Evidence integrity

| Measure | Detail |
|---|---|
| Originals | Stored once, read-only, addressed by SHA-256. Administration → Integrations → *Verify every stored file* re-hashes them all. |
| Original text | The submitted text is immutable. Edits go to a working copy, and every change writes a full version snapshot. |
| OCR | The original extraction is immutable; corrections are versioned. |
| Approved reports | Frozen with a SHA-256 of their JSON. |
| Audit log | Hash-chained. `npm run verify-audit` or Administration → Audit log → *Verify integrity* detects edited or deleted entries. |
| What is logged | Sign-ins, every case change, media downloads, report exports and each AI request (destination, model, payload hash). |

## AI safeguards

| Safeguard | Detail |
|---|---|
| Off by default | AI is off until a provider, model and key are set on the server. Administrators can switch it off at any time. |
| API key | Read from the environment only. Never stored in the database, logged or sent to the browser. Provider error messages are scrubbed of the key. |
| Explicit sending | Nothing is sent without an analyst's preview and confirmation. Only selected images (resized) and the case text and evidence are sent; originals never are. |
| Untrusted content | Uploaded content is treated as untrusted data. It sits inside a delimited data block in the user message, never in the system prompt. The model is told not to follow instructions in it. Instruction-like text is flagged to the analyst. |
| Strict output | Output must match a strict schema. Any reference to an ID that was not sent rejects the whole reply. |
| No automatic actions | Output never triggers an action. Analysts accept items one by one, and accepted items are labelled as AI-originated in the report. |

## Deployment checklist

- [ ] Serve over HTTPS (reverse proxy) and set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.
- [ ] Keep `HOST=127.0.0.1` behind the proxy, or firewall the port.
- [ ] Back up `data/` (database and objects) on a schedule. Test a restore and run `npm run verify-audit` after it.
- [ ] Encrypt the disk holding `data/`. The application does not encrypt at rest.
- [ ] Delete `data/FIRST-LOGIN.txt` after the first sign-in.
- [ ] Decide, and record approval for, any AI provider and region before setting `AI_*` variables. Check the provider's data-retention terms.
- [ ] Re-tune the matching thresholds on the approved dataset.
- [ ] Run `npm audit` before deployment and on a schedule.

## Added in 1.3 (Phase 1)

- **Link retrieval (Verify Information).** Before any request, every address the host name resolves to is checked. Loopback, private, link-local (including cloud metadata at 169.254.169.254), carrier-grade NAT, multicast and reserved IPv4 and IPv6 ranges are refused.
  - **Pinning:** the checked address is pinned for the connection, so a second DNS answer cannot change the target.
  - **Redirects:** each redirect is checked again, up to 5.
  - **Limits:** 12 s timeout, 3 MB body, bounded decompression; HTML and plain text only; no cookies or credentials.
  - **Archiving:** the page is archived unchanged and served back only as a download with `Content-Security-Policy: sandbox`. Its text is treated as untrusted data; instruction-like text is flagged to the analyst and never obeyed.
- **Rate limits.**
  - **Budgets:** each user, or each IP address before sign-in, has a general budget and a tighter "heavy" budget for retrieval, uploads, analysis, AI requests, archive changes and imports. Over budget, the server returns 429 with `Retry-After`.
  - **Scope:** the counters live in memory per process. In a multi-server deployment, add limits at the reverse proxy as well.
- **Image check.** The uploaded image is compared and then deleted. Only its SHA-256 is written to the audit log.
- **Search.** LIKE wildcards are escaped, and results respect the operational and training separation.
- **Not yet built:** data retention periods and deletion controls (Phase 6). Until they exist, the operator must set and apply a retention policy.
