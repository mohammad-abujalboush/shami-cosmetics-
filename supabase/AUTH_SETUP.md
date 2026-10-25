# Supabase Auth setup (customer accounts)

Dashboard → **Authentication**. Replace `https://YOUR-DOMAIN` with the production domain (Netlify / Cloudflare Pages).

## 1. URL Configuration (Authentication → URL Configuration)

| Field | Value |
|---|---|
| **Site URL** | `https://YOUR-DOMAIN` |
| **Redirect URLs** (one per line) | `https://YOUR-DOMAIN/account/login.html` |
| | `https://YOUR-DOMAIN/account/reset-password.html` |
| | `https://YOUR-DOMAIN/account/` |
| | `http://localhost:3000/account/login.html` |
| | `http://localhost:3000/account/reset-password.html` |
| | `http://localhost:3000/account/` |

The site uses these three paths only (`emailRedirectTo` after sign-up and e-mail change, `redirectTo` for password reset).
Local dev: the list assumes `npx serve` on port 3000. If another port is used (VS Code Live Server = 5500), add the same three lines for it.
Do **not** add a wildcard for the whole production domain, and never leave the Site URL on `localhost` in production (reset links would point there).

## 2. Sign-in settings

- **Sign In / Providers → Email**: enabled. **Confirm email: ON** (the account pages handle both modes; ON is recommended so nobody registers with someone else's address).
- **Minimum password length: 8** (the pages also enforce 8 on the client).
- **Allow new users to sign up: ON**.
- Other providers (Google, phone, anonymous): OFF.
- **Secure email change: ON** (default). The change-email message then goes to both the old and the new address, using the "Change Email Address" template below.

## 3. SMTP (important before launch)

Supabase's built-in mailer only delivers to members of your Supabase organisation and is limited to a few e-mails per hour. Real customers will not receive confirmation or reset mails until a custom SMTP is set (Authentication → Emails → SMTP Settings: e.g. Resend, Brevo, Postmark, Amazon SES). Use a sender such as `Shami Cosmetics <no-reply@YOUR-DOMAIN>` and set sender name = `Shami Cosmetics`.

## 4. Email templates (Authentication → Emails → Templates)

Paste the **Subject** and the **Message body** (HTML source) for each template. Layout is RTL; fonts fall back to Tahoma/Arial because mail clients don't load Cairo. Variables are Supabase's: `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .NewEmail }}`.

### 4.1 Confirm signup

**Subject:** `تأكيد البريد الإلكتروني — Shami Cosmetics`

```html
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<body style="margin:0;padding:0;background:#FBF8F2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F2;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #E8DDC4;border-radius:16px;">
      <tr><td align="center" style="padding:28px 24px 8px;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:26px;color:#1C1712;">Shami Cosmetics</td></tr>
      <tr><td dir="rtl" align="right" style="padding:8px 28px 4px;font-family:Tahoma,Arial,sans-serif;font-size:20px;font-weight:bold;color:#1C1712;text-align:right;">تأكيد البريد الإلكتروني</td></tr>
      <tr><td dir="rtl" align="right" style="padding:8px 28px;font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.9;color:#3b342b;text-align:right;">
        شكرًا لإنشاء حساب في Shami Cosmetics. لتفعيل الحساب، يرجى الضغط على الزر التالي لتأكيد البريد الإلكتروني <span dir="ltr" style="unicode-bidi:embed;">{{ .Email }}</span>.
      </td></tr>
      <tr><td align="center" style="padding:16px 28px;">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#8A6A2A;color:#FBF8F2;font-family:Tahoma,Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:14px 34px;border-radius:30px;">تأكيد البريد الإلكتروني</a>
      </td></tr>
      <tr><td dir="rtl" align="right" style="padding:0 28px 8px;font-family:Tahoma,Arial,sans-serif;font-size:13px;line-height:1.8;color:#6B6255;text-align:right;">
        إذا لم يعمل الزر، يمكن نسخ الرابط التالي ولصقه في المتصفح:<br>
        <a href="{{ .ConfirmationURL }}" dir="ltr" style="color:#8A6A2A;word-break:break-all;unicode-bidi:embed;">{{ .ConfirmationURL }}</a>
      </td></tr>
      <tr><td dir="rtl" align="right" style="padding:8px 28px 28px;font-family:Tahoma,Arial,sans-serif;font-size:12.5px;line-height:1.8;color:#8a8174;text-align:right;">
        إذا لم يتم إنشاء حساب بهذا البريد، يمكن تجاهل هذه الرسالة.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
```

### 4.2 Reset password

**Subject:** `استعادة كلمة المرور — Shami Cosmetics`

```html
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<body style="margin:0;padding:0;background:#FBF8F2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F2;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #E8DDC4;border-radius:16px;">
      <tr><td align="center" style="padding:28px 24px 8px;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:26px;color:#1C1712;">Shami Cosmetics</td></tr>
      <tr><td dir="rtl" align="right" style="padding:8px 28px 4px;font-family:Tahoma,Arial,sans-serif;font-size:20px;font-weight:bold;color:#1C1712;text-align:right;">استعادة كلمة المرور</td></tr>
      <tr><td dir="rtl" align="right" style="padding:8px 28px;font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.9;color:#3b342b;text-align:right;">
        وصل طلب لتعيين كلمة مرور جديدة للحساب المرتبط بالبريد <span dir="ltr" style="unicode-bidi:embed;">{{ .Email }}</span>. للمتابعة، يرجى الضغط على الزر التالي.
      </td></tr>
      <tr><td align="center" style="padding:16px 28px;">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#8A6A2A;color:#FBF8F2;font-family:Tahoma,Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:14px 34px;border-radius:30px;">تعيين كلمة مرور جديدة</a>
      </td></tr>
      <tr><td dir="rtl" align="right" style="padding:0 28px 8px;font-family:Tahoma,Arial,sans-serif;font-size:13px;line-height:1.8;color:#6B6255;text-align:right;">
        إذا لم يعمل الزر، يمكن نسخ الرابط التالي ولصقه في المتصفح:<br>
        <a href="{{ .ConfirmationURL }}" dir="ltr" style="color:#8A6A2A;word-break:break-all;unicode-bidi:embed;">{{ .ConfirmationURL }}</a>
      </td></tr>
      <tr><td dir="rtl" align="right" style="padding:8px 28px 28px;font-family:Tahoma,Arial,sans-serif;font-size:12.5px;line-height:1.8;color:#8a8174;text-align:right;">
        الرابط صالح لمدة محدودة ويُستخدم مرة واحدة. إذا لم يُطلب تغيير كلمة المرور، يمكن تجاهل هذه الرسالة وتبقى كلمة المرور الحالية كما هي.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
```

### 4.3 Change email address

**Subject:** `تأكيد تغيير البريد الإلكتروني — Shami Cosmetics`

```html
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<body style="margin:0;padding:0;background:#FBF8F2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F2;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #E8DDC4;border-radius:16px;">
      <tr><td align="center" style="padding:28px 24px 8px;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:26px;color:#1C1712;">Shami Cosmetics</td></tr>
      <tr><td dir="rtl" align="right" style="padding:8px 28px 4px;font-family:Tahoma,Arial,sans-serif;font-size:20px;font-weight:bold;color:#1C1712;text-align:right;">تأكيد تغيير البريد الإلكتروني</td></tr>
      <tr><td dir="rtl" align="right" style="padding:8px 28px;font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.9;color:#3b342b;text-align:right;">
        وصل طلب لتغيير البريد الإلكتروني للحساب من
        <span dir="ltr" style="unicode-bidi:embed;">{{ .Email }}</span>
        إلى
        <span dir="ltr" style="unicode-bidi:embed;">{{ .NewEmail }}</span>.
        لإتمام التغيير، يرجى الضغط على الزر التالي.
      </td></tr>
      <tr><td align="center" style="padding:16px 28px;">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#8A6A2A;color:#FBF8F2;font-family:Tahoma,Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:14px 34px;border-radius:30px;">تأكيد التغيير</a>
      </td></tr>
      <tr><td dir="rtl" align="right" style="padding:0 28px 8px;font-family:Tahoma,Arial,sans-serif;font-size:13px;line-height:1.8;color:#6B6255;text-align:right;">
        إذا لم يعمل الزر، يمكن نسخ الرابط التالي ولصقه في المتصفح:<br>
        <a href="{{ .ConfirmationURL }}" dir="ltr" style="color:#8A6A2A;word-break:break-all;unicode-bidi:embed;">{{ .ConfirmationURL }}</a>
      </td></tr>
      <tr><td dir="rtl" align="right" style="padding:8px 28px 28px;font-family:Tahoma,Arial,sans-serif;font-size:12.5px;line-height:1.8;color:#8a8174;text-align:right;">
        إذا لم يُطلب هذا التغيير، يمكن تجاهل الرسالة وتبقى بيانات الحساب كما هي. يُنصح بتغيير كلمة المرور عند الشك بأي نشاط غير معروف.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
```

(The "Magic link", "Invite user" and "Reauthentication" templates are not used by the store.)

## 5. Deleting a throw-away test account

SQL editor, in this order (orders keep a snapshot of the customer, so they are not removed with the account):

```sql
-- 1. look first
select id, email from auth.users where email = 'TEST-EMAIL';
-- 2. the account's test orders (items, history and reviews cascade)
delete from public.orders where user_id = (select id from auth.users where email = 'TEST-EMAIL');
-- 3. the account itself (profile and saved addresses cascade)
delete from auth.users where email = 'TEST-EMAIL';
```

Or: Dashboard → Authentication → Users → ⋯ → Delete user (steps 1–2 still need the SQL above for orders).
