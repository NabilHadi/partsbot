# Admin web UI (`/admin`)

Server-rendered pages served by the main Fastify process (`dist/main.js`). There's no frontend build and no JavaScript in the browser.

## Access

- One admin user. The password is `ADMIN_PASSWORD` in the server's environment (locally it is loaded from `logs/secrets.env`). It is never logged or shown.
- **If `ADMIN_PASSWORD` is unset, every `/admin` URL answers 503** (fail closed).
- The login sets a signed session cookie (`HttpOnly; Secure; SameSite=Strict; Path=/admin`, 12 h). The signing key is random for each process, so **restarting the server logs the admin out**.
- Every POST carries a CSRF token bound to the session. Logging in issues a fresh session id.
- Login rate limit: 5 failures per client (Cloudflare `CF-Connecting-IP`, otherwise the socket IP) and 30 overall per 15 minutes. Past that, logins get 429 with `Retry-After`.
- Response headers: strict CSP (no scripts), `X-Frame-Options: DENY`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
- Because the cookie is `Secure`, log in over https (the tunnel URL), not plain http.

## Pages

| Route | What |
| --- | --- |
| `GET /admin/login`, `POST /admin/login`, `POST /admin/logout` | Sign in / out |
| `GET /admin/shops` | Shops: name, Zernio account, status, staff count, last import, bot messages today/total, conversations |
| `GET /admin/shops/new`, `POST /admin/shops` | Create a shop |
| `GET /admin/shops/:id` | Shop details, every shop-config setting, hours, staff, stock import + history, recent audit |
| `POST /admin/shops/:id/details` | Name, city, Zernio account id, WABA id, plan, status |
| `POST /admin/shops/:id/settings` | Settings. Validated by the same zod schema (`shopConfigSchema`) as the CLI; errors are shown inline and an invalid config is never saved. An empty field means "use the default". |
| `POST /admin/shops/:id/staff`, `.../staff/remove` | Staff add/remove. Phones are normalized to E.164 and shown as the last 4 digits only. |
| `POST /admin/shops/:id/import` | CSV/XLSX/XLSM upload. Same importer as `npm run stock:import`. The file goes to a private temp dir and is deleted after the import; nothing is uploaded anywhere. |
| `GET /admin/app` | Read-only: DRY_RUN, OneEPC URL + reachability, Zernio configured yes/no, DB, queue depth, version/commit |
| `GET /admin/audit` | Last 200 admin actions (who, what, when in Asia/Riyadh) |

The audit log (`admin_audit_log`, migration 005) records logins, failed logins, shop/settings/staff changes and imports. Staff phone numbers and passwords are never written to it.

## Tests

`src/admin/*.test.ts`. The DB-backed test runs only with `TEST_DATABASE_URL` set (a throwaway database, e.g. `partsbot_test`).
