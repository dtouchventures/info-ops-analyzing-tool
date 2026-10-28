# Login reference assets

These assets were supplied by the user in the referenced “Generate Presentation Content” conversation.

- `kdf.png`: original `DF LOGO_ 2 (1).png`, copied without modification.
- `dmi.png`: original `DMI Logo copy.png`, copied without modification.
- `operations-reference.png`: original approved split-screen mockup, `image(20261028-114157).png`. CSS displays its lower-left operations scene as decorative background; its illustrated emblem, credentials, and form are outside the displayed crop. The working form and branding are HTML.

The visible academic/unofficial label must remain unless organizational authorization is confirmed. Emblems do not establish endorsement.

Authentication remains on the existing API, cookie session, CSRF checks, and forced-password-change flow. Credentials are never prefilled; errors are rendered as text. First-install credential recovery remains an administrator responsibility.

Validation: `node test/login-redesign.mjs` (installed Chrome or `CHROMIUM_PATH`) and `node --test --test-isolation=none test/api.test.js test/admin.test.js`. Browser tests use a temporary database and the project's synthetic test accounts, never production credentials.
