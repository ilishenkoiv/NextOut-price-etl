# NextOut Price ETL

A standalone data-collection pipeline that gathers flight prices for the *NextOut* travel
app and writes them into a Supabase database. It contains no product logic — no ranking,
no scoring, no UI.

## Stack

| Concern | Tool |
| --- | --- |
| Runtime | Node.js 22, ES modules |
| Source API | External flight-data provider |
| Storage | Supabase (Postgres) via `@supabase/supabase-js` |
| Scheduling | GitHub Actions |
| Tests | `node --test` |

## License

Proprietary. All rights reserved — see [LICENSE](./LICENSE).

You may read this repository. You may not use, copy, modify or distribute it without
written permission.

---

© 2026 Ilia Ilishenko. All rights reserved.
