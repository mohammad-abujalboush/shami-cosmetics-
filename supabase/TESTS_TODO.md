# Tests to run at the end

Running list of TESTS.md sections that must be (re)run on the real project because the SQL
(or the tests) changed since they last passed there. Run them in this order, in the SQL editor,
using the **current** TESTS.md. After a clean run, clear the list.

1. **Step 0**: install / refresh the test helpers (always first)
2. **5**: Order status transitions (lookups now return `{"error": …}`)
3. **6**: Staff restrictions (baseline staff count)
4. **9**: What the public and customers can see (fixture ids, quiz isolation)
5. **12**: Grants (new owner function `mark_refunded`, new functions `staff_overview`, `staff_names`, `set_staff_active`, `coupon_stats`, `sales_report`, new public view `catalog_products`, new function `product_reviews`; choose **Run without RLS** at the warning)
6. **13**: Refunds (new; COD returned → refund_due, needs `upgrade_04_cod_refund.sql` first)
7. **14**: Order lookup brute-force guard (new)
8. **15**: Payment proofs, at most 3 files (new)
9. **16**: Storefront catalog view and product reviews (new)
10. **17**: Staff dashboard and Realtime (new; needs `upgrade_05_admin_core.sql` first)
11. **18**: Admin pages: staff names, activation, coupon stats, sales report (new; needs `upgrade_06_admin_pages.sql` first)
12. **Step 99**: remove the test helpers

Upgrades to run first (existing project, in order): `upgrade_04_cod_refund.sql`, `upgrade_05_admin_core.sql` (done 2026-10-26), `upgrade_06_admin_pages.sql` (pending), `upgrade_07_staff_profiles.sql` (pending, + Edge Function `admin-users`). Fresh installs already contain all of them.

## Log
- 2026-09-27: 5, 6, 9, 12 failed on the live project, but that run used a stale TESTS.md (old `list_staff() = 3` check, old `expect_error` in 5). Rerun with the current file.
- 2026-09-27: added 13–15 (refunds, lookup guard, proof limit), then 16 (catalog view + `product_reviews`, from `upgrade_03_catalog.sql`).
- 2026-10-25: rule changed: any paid order cancelled/returned → `refund_due` (incl. returned COD). Section 13 test C and the dashboard counts updated.
- 2026-10-26: added `staff_overview()` + Realtime publication of `orders` (upgrade_05); section 12 function list and new section 17.
- 2026-10-27: added `staff_names()`, `set_staff_active()`, `coupon_stats()`, `sales_report()` (upgrade_06); section 12 function list and new section 18.

- 2026-11-04: added upgrade_07 (staff_details, account_flags, activity_log, my_account_flags, complete_password_change, owner_update_staff, set_staff_role, list_customers, customer_detail, activity_feed, service-role helpers). Section 12 (grants) function list, section 6 (staff restrictions) and section 18 need the new functions added; `is_staff()`/`is_owner()` now also return false while a password change is pending.
