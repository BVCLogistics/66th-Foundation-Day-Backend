# BVC Foundation Week backend

This Cloudflare Worker provides the GitHub Pages site’s work-email verification and submission API, plus an authenticated reviewer dashboard. A D1 database holds reviewer permissions and submissions. Attachments are stored in a private R2 bucket and served only after reviewer authorization. Reviewers can download individual files or a ZIP of all entries.

## Deployment

1. Run `npm ci` and `npm run build`. Deploy `dist/server/index.js` as a Cloudflare Worker.
2. Apply the numbered SQL migrations in order to the D1 database. Preserve existing migrations and data on upgrades.
3. Bind `DB` to that D1 database and `BUCKET` to a private R2 bucket.
4. Set `AUTH_SECRET` to a strong random secret and `BREVO_API_KEY` to an authorized Brevo transactional email key. Store both as runtime secrets.
5. Set `EMAIL_FROM` to the email address of a verified Brevo sender and `REVIEWER_ADMIN_EMAIL` to the person who should manage reviewer access.
6. The GitHub Pages origin defaults to `https://bvclogistics.github.io`. Set `EMPLOYEE_WEB_ORIGIN` explicitly for another trusted frontend origin and point the frontend at this deployment’s `/api/employee/` routes.
7. Open the dashboard at the Worker’s root URL, verify the admin email, and add authorized reviewers under **Manage reviewer access**. Employees can submit after verifying any `@bvclogistics.com` address.

The entry cutoff is midnight at the end of 2 December 2026 in India. The maximum combined attachment size is 25 MiB per entry. The optional server-to-server intake uses `INGEST_KEY` when the existing trusted site bridge is required.
