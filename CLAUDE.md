# Shami Cosmetics — Project Rules

Jordanian cosmetics e-commerce store (Turkish medical soap, TWINS perfumes, gift boxes).
Stack: plain HTML/CSS/JS (no framework, no build step) + Supabase (Postgres, Auth, Storage, RPC).
Hosted as static files (Netlify / Cloudflare Pages).

## Language & UI rules — ARABIC FIRST
Arabic is the primary and default language of the entire project: storefront, customer account, admin panel, emails, WhatsApp messages, error messages, print slips. English appears only in brand names (Shami Cosmetics, TWINS) and product names where the brand uses them.
Code identifiers, table names, and comments stay in English.

Layout & direction
- Every page: <html lang="ar" dir="rtl">. Design and test in RTL first; never build LTR and flip.
- Use CSS logical properties (margin-inline-start, padding-inline-end, inset-inline-start, text-align: start) instead of left/right.
- Directional icons (arrows, chevrons, "next/back") are mirrored for RTL. The cart drawer slides in from the left; the admin sidebar is on the right.
- Phone numbers, emails, order numbers, coupon codes, SKUs, and CliQ aliases are rendered and typed inside dir="ltr" spans/inputs so they don't scramble.

Typography
- Cairo is the main font for all UI text, headings, and numbers. Playfair Display is only for the "Shami Cosmetics" wordmark. Load only the weights actually used.
- Line-height and font sizes tuned for Arabic (base 16px, line-height ≈1.8 for body).

Numbers, currency, dates
- Display Western digits (0-9), which is standard in Jordan. Use Intl with 'ar-JO' and numberingSystem 'latn'.
- Prices: number then "د.أ" → "18 د.أ", "2.5 د.أ". Prices stored numeric(10,3), trailing zeros trimmed.
- Dates in Arabic with Asia/Amman timezone: "26 أيلول 2026، 3:40 م" (Levantine month names: كانون الثاني، شباط، آذار، نيسان، أيار، حزيران، تموز، آب، أيلول، تشرين الأول، تشرين الثاني، كانون الأول).
- Every input that accepts numbers (phone, quantity, CliQ reference, coupon) must convert Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) and Persian digits to Western before validating/sending. Customers on Arabic keyboards will type them.

Text & copy
- All UI strings live in /assets/js/strings.ar.js (one object, grouped by page). No hardcoded UI text scattered in HTML/JS. This also makes an English version possible later without a rewrite.
- Copy is natural Jordanian-friendly Modern Standard Arabic and GENDER-NEUTRAL everywhere (storefront, account, admin, errors, emails, WhatsApp, SQL seed/notices). Rules, in priority order:
  a) Prefer neutral noun / verbal-noun forms: "إضافة إلى السلة", "إتمام الطلب", "تتبع الطلب", "بدء الاختبار", "يرجى إدخال رقم الهاتف".
  b) Only where a verb addressed to the customer is unavoidable, use the standard generic masculine form (أدخل، اختر، تسوق) — e.g. "تسوق الآن" only if no noun form reads naturally.
  c) No feminine-only phrasing anywhere (تسوقي، أدخلي، عميلة، عزيزتي). Use "العميل" / "عملاؤنا" or rephrase.
  demo.html is the visual reference only; its feminine copy is not to be reused.
- Never show raw browser or Supabase English errors. Use custom validation (novalidate on forms) with Arabic messages. RPC functions return error CODES (e.g. OUT_OF_STOCK, COUPON_EXPIRED, RATE_LIMITED), and the frontend maps each code to an Arabic message in strings.ar.js.
- Empty states, loading text, toasts, confirmations, print slips, email templates, and WhatsApp templates are all in Arabic.

Arabic search
- Product search normalizes Arabic on both sides: remove tashkeel and tatweel, أ/إ/آ → ا, ة → ه, ى → ي, ؤ → و, ئ → ي. Implement as a Postgres function normalize_ar(text) plus a generated search column on products (name_ar + name_en + tags), and apply the same normalization in JS.
- Arabic sorting uses proper collation (localeCompare with 'ar').

Content model
- name_ar and description_ar are REQUIRED. name_en is optional.
- Product/category URLs use a Latin slug the admin can edit. Auto-generate from name_en if present, otherwise from the product ID (e.g. p-1042). Never put raw Arabic in URLs.

SEO
- Arabic <title>, meta description, and Open Graph tags on every page, og:locale = ar_JO.

General
- Design system = the existing demo.html (colors, spacing, components); reuse its CSS variables exactly.
- Shared CSS in /assets/css, shared JS in /assets/js. Header/footer injected by /assets/js/layout.js.
- Every data view needs loading, empty, and error states in Arabic. No placeholder data.
- Mobile-first, accessible (Arabic labels on every input, visible focus, prefers-reduced-motion respected).

## Security (non-negotiable)
- Browser is untrusted. Prices, totals, discounts, delivery fees, and stock are ONLY calculated in Postgres functions. The client sends variant IDs + quantities, never prices.
- Every table has RLS enabled. Permissions are enforced in RLS/RPC, not by hiding buttons.
- Only the anon key in frontend (/assets/js/config.js). Never the service_role key.
- Admin pages check staff role on load and redirect if not authorized, but real protection is RLS.

## Catalog
- Categories: soap, twins_perfumes, twins_unity, gift_boxes (admin-managed, sortable).
- Product has: name_ar, name_en, description_ar, category, gender (men/women/unisex/null), tags[] (used by quiz, e.g. sensitive, oily, dry, acne, whitening), is_bestseller, active, sort, multiple images.
- Product variants: label (e.g. "50ml", "قطعة واحدة"), sku, price, compare_at_price (optional, must be > price to show strikethrough), stock, low_stock_threshold (default 5), active.
- Every product has at least one variant. "From X JD" = cheapest active variant.
- stock = 0 → show "نفذت الكمية", disable add to cart. Cart quantity cannot exceed stock.

## Delivery
- 12 Jordanian governorates, each with an editable delivery fee and active flag.
- Settings: free_delivery_threshold (nullable). Threshold applies to subtotal after discounts.

## Offers & coupons
- Bundle offer: category + quantity N + fixed bundle_price, with starts_at/ends_at, active, show_countdown.
  Applied automatically. Eligible units sorted by price DESC, grouped into sets of N; each full set costs bundle_price. Remaining units full price.
- Only one bundle offer per category active at a time (enforced).
- Countdown shows the REAL ends_at of the active offer. If no active offer, hide the section. Never fake timers.
- Coupons: code (case-insensitive, stored uppercase), percent or fixed, min_order, max_uses, used_count, max_per_phone, starts_at, ends_at, combinable_with_offers, active.
  Applied after bundle discounts, never makes subtotal negative. Percent coupons can have max_discount.
- Order of calculation: subtotal → bundle discount → coupon discount → delivery fee (0 if threshold met) → total.

## Checkout & orders
- Guest checkout allowed. Logged-in customers get name/phone/saved addresses prefilled and the order linked to their account.
- Fields: full name, phone (Jordan mobile: 07[789]XXXXXXX, stored as 9627XXXXXXXX), governorate, area, address details, notes (optional), payment method.
- Payment methods: cod, cliq.
  - cliq: after placing order, customer sees CliQ alias + account name (from settings) + exact amount + order number to write in the transfer note, then uploads a receipt screenshot and/or enters the reference. payment_status = awaiting_transfer → awaiting_verification after upload.
  - Unverified CliQ orders older than settings.cliq_window_hours (default 24) are flagged in admin (not auto-cancelled).
- Order number: human readable sequential, format SH-10001.
- Each order also has a public_token (uuid) used for the success page and receipt upload.
- order_items store snapshots: product name, variant label, unit price, quantity, line total (prices never change retroactively).
- Rate limit: max 3 orders per phone per hour.
- After success: WhatsApp button opening wa.me/<store number> with prefilled Arabic order summary.

## Order lifecycle
Statuses: new → confirmed → with_courier → delivered; cancelled; returned.
Allowed transitions:
- new → confirmed | cancelled
- confirmed → with_courier | cancelled
- with_courier → delivered | returned | cancelled
- delivered → returned
- CliQ orders cannot move to with_courier unless payment_status = paid.
Payment status: unpaid, awaiting_transfer, awaiting_verification, paid, refunded. COD becomes paid when delivered.
Stock: decremented when order is placed. Cancelled → restocked automatically. Returned → restocked only if admin ticks "إرجاع للمخزون" (returned cosmetics may not be resellable).
Customers can cancel their own order only while status = new.
Every status change writes order_status_history (who, when, from, to, note).
Every stock change writes stock_movements (variant, change, reason: order/cancel/return/manual, order_id, by).

## Customer accounts (optional)
- Supabase email + password. Profile: full name, phone. Multiple saved addresses, one default.
- Account page: order history with status, reorder button, addresses management.
- Order tracking also works without account: order number + phone.

## Reviews
- Customers can leave a review from the tracking page only after their order is delivered (one per order).
- Reviews need approval before showing publicly. Admin can also feature reviews on the homepage.
- Homepage stats (customers count, rating, etc.) come from settings, editable or hideable. No invented numbers.

## Skin quiz
- 3 questions, admin-editable. Each option maps to tags. Result = active soap products ranked by matching tags (top 3), with add-to-cart.

## Staff roles
- staff table: user_id, role (owner | staff), active.
- First owner inserted manually via SQL. Owner promotes existing accounts by email via RPC add_staff(email, role).
- Owner: everything.
- Staff: view and manage orders (status changes, internal notes, print slips), manual stock adjustments (logged), moderate reviews.
  Staff CANNOT: edit prices/products, offers, coupons, delivery fees, settings, staff; verify CliQ payments; see revenue reports.

## Settings (single row)
store_whatsapp, cliq_alias, cliq_account_name, cliq_window_hours, free_delivery_threshold, top_bar_messages[], homepage stats (json, each with show flag), return_policy_ar, social links, store_open (if false, checkout disabled with a message).