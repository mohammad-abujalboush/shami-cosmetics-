# Admin core — setup and click-through checklist

## SQL to run (existing project)

1. `upgrade_05_admin_core.sql` (adds `staff_overview()` and publishes `orders` to Realtime). Fresh installs get it from `03_functions.sql` + `02b_grants.sql`.
2. TESTS: section 12 (updated function list) and the new section 17, then clear `TESTS_TODO.md`.

## Realtime (new-order notification + sound)

The SQL above already does the one thing needed. In the dashboard you only verify it:

1. **Database → Publications → `supabase_realtime`**: the table **`orders`** must be switched on (and nothing else private: not `staff`, `coupons`, `settings`, `order_notes`, `profiles`, `addresses`). If it is off, switch it on there instead of running the SQL.
2. **Project Settings → API → Realtime** (or **Realtime → Settings**): Realtime must be enabled (default on). Leave "Allow public access" alone: it only concerns Broadcast/Presence channels; the admin panel uses *Postgres Changes*.
3. Nothing else: no extra RLS policy is needed. Postgres Changes evaluates the table's `SELECT` policy (`orders: read own or staff`) for each subscriber's JWT, so staff receive every new order, a customer receives only their own, guests receive nothing.

Security check: the only data that reaches the browser is the `orders` row, and only to users the SELECT policy allows. The admin page uses the event for the toast and counter only; the list is re-read through the normal API.

Notes: browsers only allow sound after a click on the page, so the first click anywhere unlocks it; the top-bar button turns the sound on/off (remembered per browser). The green dot in the top bar means the Realtime channel is connected.

## Click-through checklist (about 10 minutes)

Use an owner account and a staff account (`add_staff` from the owner), plus a normal customer account.

**Login and guard**
1. Customer account on `/admin/login.html` → "غير مصرح", and the customer is signed out.
2. Logged out, open `/admin/orders.html` → sent to login, and after login back to the orders page.
3. Staff login: sidebar has لوحة التحكم + الطلبات only; dashboard shows طلبات تحتاج متابعة, CliQ متأخر, مخزون منخفض, and **no** sales / date range.
4. Owner login: the date range buttons (اليوم / 7 / 30 / مخصصة) change the numbers; "مبالغ مستحقة للإرجاع" shows count + amount and links to the filtered list.

**Orders list**
5. Filters (status, payment method, payment status incl. مبلغ مستحق للإرجاع, governorate, dates), search by order number, phone (also typed with Arabic digits) and name; the URL keeps the filters.
6. A CliQ order older than the CliQ window (settings) is highlighted with "تحويل CliQ متأخر"; a refund-due order with "إرجاع مبلغ".
7. Select a few rows → "طباعة ملصقات المحدد" opens `/admin/print.html`.
8. Keep the orders page open, place an order from the store in another browser → toast + beep, sidebar counter +1, the new row appears on top.

**Order page**
9. A new order offers only تأكيد / إلغاء. A CliQ order whose payment is not confirmed shows "نقل إلى: مع شركة التوصيل" disabled.
10. Move a with-courier order to مرتجع: the dialog shows "إرجاع للمخزون"; tick it → stock goes up (`stock_movements` or the variant stock in the shop); untick → stock unchanged. Cancelling restocks automatically.
11. A delivered COD order that is returned becomes "مبلغ مستحق للإرجاع"; as staff there is no refund button, as owner "تأكيد الإرجاع" with a note works and shows in the history.
12. Owner, CliQ order with an uploaded receipt: images show (signed links), تأكيد استلام الدفع → مدفوع, رفض الإيصال → back to بانتظار التحويل. Staff sees "متاحان للمالك فقط" instead.
13. Internal note: add and delete; history shows payment changes ("الدفع: … ← …").
14. WhatsApp: the template follows the status, the text is editable, the button opens `wa.me/<customer number>`.

**Print**
15. `print.html`: toggle A4 / حراري 80 مم, press طباعة and check the preview: one slip per page, amount to collect = 0 with "مدفوع مسبقًا" for a paid order, the full total otherwise.
