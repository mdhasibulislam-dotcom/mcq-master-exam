# MCQ Master Exam

Interactive MCQ practice web app for students — with Student and Admin panels.

**Live stack:** HTML, CSS, Vanilla JavaScript, Supabase (Auth, PostgreSQL, RLS, Edge Functions)

## Features

- Student login / registration with email, username or phone
- Admin panel — manage users, questions and exams
- MCQ exams with timer, scoring and results
- Student profile (photo, level, school/college, district)
- Bulk question import
- Password reset

## Project structure

- `index.html` — login / registration
- `student.html` — student dashboard
- `admin.html` — admin dashboard
- `admin-login.html` — admin login
- `js/` — frontend logic (`auth.js`, `student.js`, `admin.js`, `profile.js`, `bulk-import.js`, `supabase-config.js`)
- `sql/` — database schema and migrations (`schema.sql`, `feature-upgrade.sql`, `profile-upgrade.sql`)
- `supabase/functions/login-with-identifier/` — Edge Function for login by email / username / phone

## Setup

Full setup instructions in Bangla: see [README-BN.md](README-BN.md).

1. Create a Supabase project and run `sql/schema.sql` in the SQL Editor.
2. If upgrading an existing database, run `sql/feature-upgrade.sql` and `sql/profile-upgrade.sql`.
3. Deploy the `login-with-identifier` Edge Function with the Supabase CLI and set its secrets (`SUPABASE_URL`, `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).
4. Set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `js/supabase-config.js`.
5. Serve the project folder with any static host (e.g. Cloudflare Pages).

> Never put the Supabase service-role key in any frontend file. It belongs only as a server-side Edge Function secret.
