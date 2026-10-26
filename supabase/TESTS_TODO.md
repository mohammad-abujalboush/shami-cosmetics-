# Tests to run at the end

Running list of TESTS.md sections that must be (re)run on the real project because the SQL
(or the tests) changed since they last passed there. Run them in this order, in the SQL editor,
using the **current** TESTS.md. After a clean run, clear the list.

1. **Step 0**: install / refresh the test helpers (always first)
2. **5**: Order status transitions (lookups now return `{"error": …}`)
3. **6**: Staff restrictions (baseline staff count)
4. **9**: What the public and customers can see (fixture ids, quiz isolation)
5. **12**: Grants (new owner function `mark_refunded`, new function `staff_overview`, new public view `catalog_products`, new function `product_reviews`; choose **Run without RLS** at the warning)
6. **13**: Refunds (new; COD returned → refund_due, needs `upgrade_04_cod_refund.sql` first)
7. **14**: Order lookup brute-force guard (new)
8. **15**: Payment proofs, at most 3 files (new)
9. **16**: Storefront catalog view and product reviews (new)
10. **17**: Staff dashboard and Realtime (new; needs `upgrade_05_admin_core.sql` first)
11. **Step 99**: remove the test helpers

Before running: run `upgrade_04_cod_refund.sql` in the SQL editor (existing project only; no grants change).

## Log
- 2026-09-27: 5, 6, 9, 12 failed on the live project, but that run used a stale TESTS.md (old `list_staff() = 3` check, old `expect_error` in 5). Rerun with the current file.
- 2026-09-27: added 13–15 (refunds, lookup guard, proof limit), then 16 (catalog view + `product_reviews`, from `upgrade_03_catalog.sql`).
- 2026-10-25: rule changed: any paid order cancelled/returned → `refund_due` (incl. returned COD). Section 13 test C and the dashboard counts updated.
- 2026-10-26: added `staff_overview()` + Realtime publication of `orders` (upgrade_05); section 12 function list and new section 17.
