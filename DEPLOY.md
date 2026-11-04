# Deploying Shami Cosmetics

Static files, no build step. Hosting: Netlify. Backend: the existing Supabase project.

## 1. Deploy to Netlify

1. Push the repo to GitHub.
2. Netlify → **Add new site → Import an existing project** → pick the repo.
3. Build command: *(empty)*. Publish directory: `.` (already set in `netlify.toml`).
4. Deploy. `netlify.toml` applies the security headers (CSP, HSTS, no framing), caching and the order/admin `no-store` rules. `404.html` is served automatically.
5. Check the headers: `curl -I https://<site>.netlify.app/` should show `content-security-policy`.

If the Supabase project ever changes, update its URL in **both** `assets/js/config.js` and the CSP in `netlify.toml`.

## 2. Connect the domain

1. Netlify → Site configuration → Domains → **Add a domain** → `YOUR-DOMAIN.com`.
2. Either use Netlify DNS (change the nameservers at the registrar), or add the records Netlify shows at the current DNS host (usually an `A` record for the apex and a `CNAME` for `www`).
3. Wait for the certificate (HTTPS → "Verify DNS configuration", then "Provision certificate"). Turn on **Force HTTPS**.
4. Replace `YOUR-DOMAIN.com` in `robots.txt` and `sitemap.xml`, commit, push.

## 3. Supabase auth URLs

Authentication → URL Configuration (full list and sign-in settings: `supabase/AUTH_SETUP.md`):

- **Site URL**: `https://YOUR-DOMAIN.com`
- **Redirect URLs**: `https://YOUR-DOMAIN.com/account/login.html`, `/account/reset-password.html`, `/account/`
- Remove the `localhost` lines once testing is finished. Never leave Site URL on `localhost`.

## 4. Brevo SMTP (customer emails)

Supabase's built-in mailer only reaches your own team and is heavily limited, so real customers get no confirmation or reset emails until SMTP is set.

1. Create a Brevo account → **Senders, domains & dedicated IPs → Domains → Add a domain** → `YOUR-DOMAIN.com`.
2. Add the DNS records Brevo displays at the domain's DNS host, exactly as shown (names and values differ per account):
   - Brevo verification code (TXT)
   - DKIM record(s) (CNAME/TXT such as `brevo1._domainkey`)
   - DMARC (TXT on `_dmarc`, e.g. `v=DMARC1; p=none; rua=mailto:you@YOUR-DOMAIN.com`)
   - If the domain already has an SPF TXT record, **add** Brevo's include to it instead of creating a second SPF record.
3. In Brevo click **Authenticate** and wait until the domain shows as verified (DNS can take up to a few hours).
4. Brevo → SMTP & API → **SMTP** → note the login and generate an SMTP key.
5. Supabase → Authentication → Emails → **SMTP Settings**: enable custom SMTP.
   - Host `smtp-relay.brevo.com`, port `587`, username = Brevo SMTP login, password = SMTP key
   - Sender email `no-reply@YOUR-DOMAIN.com`, sender name `Shami Cosmetics`
6. Paste the templates from `supabase/AUTH_SETUP.md` §4, then register a test account with an outside address (Gmail) and check the confirmation arrives (and not in spam).

## 5. Go-live order

Do these in order. Each step depends on the previous one.

1. **Run the `supabase/TESTS_TODO.md` blocks** in the SQL editor (Step 0 first, current `TESTS.md`). Every block must pass. Fix and re-run on any failure.
2. **Step 99** of `TESTS.md`: removes the test helpers (`test` schema).
3. **`supabase/99_remove_dev_seed.sql`**: removes the `[تجربة]` sample data and restores the original settings and governorate fees.
4. **Delete your test orders and accounts.**
   - Review first: `select order_number, customer_name, phone, created_at from orders order by created_at;`
   - `delete from orders where ...;` (cascades to items, history, notes, reviews)
   - Delete test customers in Supabase → Authentication → Users. Keep your owner account.
5. **`supabase/98_prelaunch_reset.sql`**: the next order becomes SH-10001. It refuses to run while any order exists.
6. **Enter the real data in the admin panel** (as owner), in this order:
   1. Settings: store WhatsApp, CliQ alias and account name, CliQ window, free-delivery threshold, top-bar messages, homepage stats (hide the ones you can't back up), return policy, social links, **store open**.
   2. Delivery: fee and active flag for each governorate.
   3. Categories (confirm the four and their order).
   4. Products with Arabic names and descriptions, images, variants, SKUs, real stock.
   5. Offers, coupons and quiz options, if used.
   6. Staff accounts (Staff page, by email).
7. **Final check on the live domain**: place one real COD order and one CliQ order, cancel both, then repeat steps 4–5 if they left data (the reset refuses to run while orders exist).
