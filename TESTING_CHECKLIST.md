# Testing checklist (click-through on the real project)

One list for everything built so far. Tick as you go; new pages are appended at the end of each prompt.
SQL checks live in `supabase/TESTS.md` (what to run is tracked in `supabase/TESTS_TODO.md`).

**Accounts you need:** an owner, a staff member (owner adds them from *فريق العمل*), a normal customer, and a guest (private window).
**Before starting:** the upgrades listed in `supabase/TESTS_TODO.md` are run, Auth settings are done (`supabase/AUTH_SETUP.md`), Realtime is on for `orders` (`supabase/ADMIN_SETUP.md`), and the dev seed is installed.
Test on a phone-width window (375 px) and a desktop window.

---

## 1. Store: cart, checkout, order, tracking

- [ ] Add a soap and a perfume to the cart; the drawer slides from the left, quantities cannot exceed stock.
- [ ] `/checkout.html` as a guest: empty submit shows Arabic errors per field; phone typed with Arabic digits (٠٧٩…) becomes 07…; choosing a governorate shows the delivery fee and the free-delivery hint.
- [ ] Coupon: wrong code → Arabic message; valid code (DEV10) → discount row; remove it again.
- [ ] Bundle: 3 soaps → the "3 for 10" saving shows in the cart and checkout.
- [ ] COD order → `/order.html?token=…` shows number SH-…, items, totals; WhatsApp button opens a prefilled Arabic message; the cart is empty afterwards.
- [ ] CliQ order → alias, account name, exact amount and the order number each have a copy button; upload a phone photo (large) → status "بانتظار التحقق"; a 4th upload is refused with the Arabic limit message.
- [ ] Out of stock during checkout: with the cart open, set a variant's stock lower in the admin, then submit → Arabic message and the line shows the available quantity.
- [ ] Rate limit: place 4 orders with the same phone within an hour → the 4th shows the Arabic message + a WhatsApp link.
- [ ] Store closed (settings) → checkout shows the closed message and cannot submit.
- [ ] `/track.html`: number + phone (also `10001` without SH-, Arabic digits) → timeline, items, totals; wrong phone → Arabic "not found" (10 wrong tries lock that order number for an hour).
- [ ] Cancel from tracking while the order is *new* (with confirmation); the button disappears once the order is confirmed.
- [ ] After an order is delivered (set in admin): review form on tracking → pending message; one review per order.
- [ ] The WhatsApp floating button is hidden on checkout and order pages on phones and sits above bottom buttons on quiz / product / track.

## 2. Customer accounts

- [ ] Register (name, 07… phone, email, password ≥ 8): Arabic errors for each bad field; success shows "check your email".
- [ ] Confirmation email arrives (Arabic RTL template) and the link opens the login page.
- [ ] Login with a wrong password → Arabic message; unconfirmed email → Arabic message.
- [ ] From `/checkout.html` click "تسجيل الدخول لتعبئة البيانات تلقائيًا" → after login you land back on checkout, the guest cart is still there, and the name / phone are prefilled.
- [ ] Header shows the first name when signed in; login link carries you back to the page you were on.
- [ ] Forgot password → reset email (Arabic) → link → new password (mismatch / short → Arabic errors) → can log in. An old / used link shows "الرابط غير صالح".
- [ ] `/account/`: orders tab (status, details link); profile tab edits name / phone (invalid name → Arabic); change email sends the confirmation mail; change password works.
- [ ] Reorder: items still in stock are added (quantities capped), unavailable ones are reported; the cart drawer opens.
- [ ] Order details (`/account/order.html?id=`): cancel while *new* (with confirmation); CliQ receipt upload while awaiting transfer.
- [ ] Addresses: add, edit, set default, delete the default (another becomes default); checkout prefills the default and offers the saved-address picker.
- [ ] Logout → header shows "تسجيل الدخول"; `/account/` redirects to login with `?next=`.

## 3. Admin core

**Login and guard**
- [ ] Customer account on `/admin/login.html` → "غير مصرح" and is signed out.
- [ ] Logged out, open `/admin/orders.html` → login, then back to orders.
- [ ] Staff sidebar: لوحة التحكم، الطلبات، المخزون، التقييمات only. Owner sees everything.
- [ ] Staff typing an owner URL (`/admin/products.html`, `/admin/settings.html`…) is sent back to the dashboard.

**Dashboard**
- [ ] Staff: pending counts, late CliQ orders, low stock; no sales numbers.
- [ ] Owner: اليوم / 7 / 30 / مخصصة change the numbers; "مبالغ مستحقة للإرجاع" shows count + amount and links to the filtered list.

**Orders list**
- [ ] Filters (status, payment method, payment status incl. مبلغ مستحق للإرجاع, governorate, dates), search by number, phone (Arabic digits too) and name; the URL keeps the filters.
- [ ] A CliQ order older than the CliQ window is flagged "تحويل CliQ متأخر"; a refund-due order "إرجاع مبلغ".
- [ ] Select rows → "طباعة ملصقات المحدد" opens the print page.
- [ ] Keep the list open, place an order in another browser → toast + beep, sidebar counter +1, the row appears on top (green dot in the top bar = connected; first click on the page unlocks sound).

**Order page**
- [ ] A new order offers only تأكيد / إلغاء. An unpaid CliQ order shows "مع شركة التوصيل" disabled.
- [ ] Return a with-courier order: the dialog has "إرجاع للمخزون"; tick → stock goes up; untick → unchanged. Cancel restocks automatically.
- [ ] A delivered COD order returned → "مبلغ مستحق للإرجاع"; staff cannot mark it refunded; owner can ("تأكيد الإرجاع" + note), shown in the history.
- [ ] Owner, CliQ order with a receipt: images open (signed links); تأكيد استلام الدفع → مدفوع; رفض الإيصال → بانتظار التحويل. Staff sees "متاحان للمالك فقط".
- [ ] Internal note add / delete; history lists status AND payment changes with **staff names** ("أنت (اسمك)" for yourself, the colleague's name for others, "العميل", "النظام").
- [ ] WhatsApp: template follows the status, text is editable, the button opens `wa.me/<customer number>`.

**Print**
- [ ] A4 / حراري 80 مم toggle; press طباعة → preview: one slip per page; amount to collect is 0 with "مدفوع مسبقًا" for paid orders, the full total otherwise.

## 4. Admin pages: catalog, store, reports

**Products (owner)**
- [ ] List: search (Arabic), category / status filters ("بدون صور", "مخزون منخفض"), active and bestseller switches; activating a product without an active variant is refused.
- [ ] New product: empty save → Arabic errors; slug typed in Arabic is refused; blank slug becomes the English-name slug or `p-<id>`; compare price ≤ price is refused; duplicate SKU is refused (also against another product); live card preview updates while typing (price, sale badge, bestseller, gender for perfumes).
- [ ] After the first save the page reloads with "تم إنشاء المنتج"; upload 2–3 phone photos → compressed, first is "رئيسية"; reorder with arrows, "تعيين كرئيسية", edit the alt text, delete one (file disappears from Storage too).
- [ ] Variants: add / edit; stock is read-only with a link to the stock page; deleting a variant that appears in an order is refused (deactivate instead); the last variant cannot be deleted.
- [ ] Deleting a product that appears in orders is refused; an unused one is deleted with its images.

**Stock (staff allowed)**
- [ ] Filters منخفض / نفذ / غير فعّال, search by name or SKU.
- [ ] Adjust: change must be a whole non-zero number (`-3` and `−3` work), reason is required, going below zero is refused; the movement history shows who (names) and why.

**Categories** · [ ] add / rename / reorder / deactivate; system categories and categories with products have no delete button.

**Offers** · [ ] creating a second active offer for the same category in an overlapping period is refused with the other offer's name; the preview shows the saving (and warns when there is none); dates are Amman time; running offers can be deactivated, only future ones deleted.

**Coupons** · [ ] code is stored uppercase; > 100 % and end-before-start are refused; used coupons can only be deactivated; usage stats (uses, discount given) look right after a test order; max uses cannot be set below the current count.

**Delivery** · [ ] 12 governorate fees + active flags save; threshold saves (blank = no free delivery); the checkout reflects both.

**Reviews (staff allowed)** · [ ] pending → approve / hide; approved → feature on the homepage; hidden → approve again.

**Quiz** · [ ] add question, add options with tags (suggested chips), reorder, delete; the public quiz follows.

**Staff** (see also section 5) · [ ] promote an existing account by email ("ترقية حساب موجود") (unknown email → Arabic message); change role; deactivate (confirmation) → that person is thrown out of the admin at once but their name stays in old histories; reactivate. You cannot deactivate yourself.

**Settings** · [ ] store open/closed; WhatsApp number (07… or international); CliQ alias and account name must be filled together (CliQ appears in checkout only when both are set); top-bar messages; homepage stats with show flags (hidden ones disappear, none are invented); return policy; social links (https only); save → the storefront shows the changes after a reload.

**Reports (owner)** · [ ] presets and custom range; daily table + bars, top products, governorates, payment-method split, refunds; **تصدير CSV** opens correctly in Excel with Arabic text.

**Phone width** · [ ] every admin page at 375 px: no sideways scrolling of the page itself (wide tables scroll inside their frame); the sidebar opens from the menu button.

---

## 5. Staff & profile management, customers, activity log

Needs `upgrade_07_staff_profiles.sql` run and the Edge Function `admin-users` deployed (`supabase/ADMIN_USERS_DEPLOY.md`).

**My profile (/admin/profile.html, every staff member; sidebar → ملفي)**
- [ ] Owner with no name: set the name → saved; invalid name / phone → Arabic errors; phone typed with Arabic digits is accepted; the name now shows in order histories.
- [ ] Change email: wrong current password → Arabic error; right password → "تم إرسال رابط التأكيد"; the old email still logs in until the link is opened; after confirming, the new one logs in.
- [ ] Change password: wrong current → error; mismatch / shorter than 8 / same as old → Arabic errors; success toast; log out and in with the new one.
- [ ] Staff (not owner) can open the page and edit only their own data.

**Create staff (owner, فريق العمل → إنشاء حساب موظف)**
- [ ] A strong password is pre-filled; "توليد" makes a new one; under 10 characters is refused.
- [ ] Save → dialog shows the password once, copy-password and copy-message work, the WhatsApp text has login link + email + password (neutral Arabic), "فتح واتساب" opens a chat; the dialog only closes with "تم" (Esc does nothing). Reopening the page never shows the password again.
- [ ] Existing email → "يوجد حساب بهذا البريد…" and the form reopens with the same values; nothing half-created in Authentication → Users.
- [ ] The new person logs in at /admin/login.html → is sent to ملفي with the forced-change notice, no sidebar; typing /admin/ or /admin/orders.html bounces back; wrong current (temporary) password refused; after the change they reach the dashboard.
- [ ] While the change is pending, the SQL editor check `select is_staff()` run as that user is false (or: they see load errors if they bypass the redirect).
- [ ] Role staff vs owner sidebar is right; the staff row shows "بانتظار تغيير كلمة المرور" until the first change.

**Owner actions per member**
- [ ] Edit name / phone / job title / notes (notes are not visible to that member).
- [ ] Change role; demoting the only active owner is refused (Arabic message); you have no actions on your own row (only a link to ملفي).
- [ ] Deactivate → they are thrown out at once; reactivate. Deactivating the last active owner is refused.
- [ ] Reset password → new temporary password shown once + message "تمت إعادة تعيين…"; the old password no longer works; next login forces the change.
- [ ] Staff user calling the function directly (console) gets NOT_AUTHORIZED.

**Customers (/admin/customers.html)**
- [ ] Owner and staff both open it; search by name (with/without hamza variants), phone (07…, Arabic digits), email.
- [ ] Registered tab: orders count, total spent (cancelled/returned excluded), last order; detail shows orders (links work) and saved addresses.
- [ ] Guests tab: grouped by phone, "عميل متكرر" badge for 2+ orders, detail lists orders and delivery addresses used.
- [ ] Owner: "تعطيل الحساب" → confirm; that customer can no longer log in (Arabic "الحساب معطّل"); "تفعيل الحساب" restores it. Staff see no disable button. Staff accounts cannot be disabled here.

**Activity log (/admin/activity.html, owner only; staff are redirected)**
- [ ] Do each once, then find it: order status change, payment verification, manual stock adjustment, product price change, settings change, delivery fee change, coupon edit, staff role change, create staff, reset password, disable customer.
- [ ] Filters: type, person, date range, text search (order number / product name / person); "عرض المزيد" pages through.
- [ ] Customer-made cancellations show "العميل"; coupon usage (used_count) does not flood the log.
