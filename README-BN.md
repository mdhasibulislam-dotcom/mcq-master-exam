# MCQ MASTER — Updated Full Project

Frontend: HTML, CSS, Vanilla JavaScript. Backend: Supabase Auth, PostgreSQL, RLS, RPC এবং Edge Function.

## প্রথমে যা করবে

1. আগের project ও Supabase Database-এর backup রাখবে। এই migration `results.score` ও `results.total`-কে numeric করে, পুরোনো RLS policy পরিবর্তন করে এবং Question/Answer access আরও সীমিত করে।
2. নতুন Supabase project হলে আগে `sql/schema.sql` চালাবে। আগের MCQ Master database থাকলে `schema.sql` আবার চালানোর দরকার নেই।
3. Supabase → SQL Editor → New query → `sql/feature-upgrade.sql`-এর সম্পূর্ণ SQL paste করে Run করবে। Error হলে পরের ধাপে যাবে না; error message সংরক্ষণ করবে।
4. Supabase → Authentication → Providers → Email চালু রাখবে। Email confirmation চালু থাকলে Signup-এর পরে confirmation email verify করতে হবে।
5. Authentication → URL Configuration-এ Site URL এবং `reset.html` Redirect URL যোগ করবে।

## Username / Phone / Email login চালু করা

Username ও phone দিয়ে password login করাতে একটি Supabase Edge Function দরকার। Function source এই project-এ আছে:

`supabase/functions/login-with-identifier/index.ts`

Supabase CLI দিয়ে project link করে deploy:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy login-with-identifier --no-verify-jwt
```

Supabase Dashboard → Edge Functions → Secrets-এ নিচের secret-গুলো নিশ্চিত করবে:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (তোমার project-এর legacy anon key; না থাকলে publishable key ব্যবহার করা যাবে)
- `SUPABASE_PUBLISHABLE_KEY` (frontend-এর public key-এর সঙ্গে হুবহু মিলতে হবে)
- `SUPABASE_SERVICE_ROLE_KEY`

`SUPABASE_SERVICE_ROLE_KEY` কখনো HTML, JavaScript, GitHub বা ZIP-এর public frontend file-এ বসাবে না। Function-এর server-side secret হিসেবেই থাকবে। Supabase runtime-এ URL/anon key আগে থেকে থাকলে শুধু অনুপস্থিত secret যোগ করবে।

## প্রথম Admin তৈরি

1. ওয়েবসাইটে নিজের account তৈরি করো এবং Email confirmation থাকলে confirm করো।
2. SQL Editor-এ নিজের email দিয়ে চালাও:

```sql
update public.profiles
set role = 'admin'
where email = 'YOUR_EMAIL@example.com';
```

3. Logout করে আবার Login করো।

## Deploy

Cloudflare Pages / Static Hosting-এ project-এর root folder upload করবে। `index.html`, `admin.html`, `student.html`, `auth.css` এবং `js/` root-এর নিচে থাকতে হবে। `supabase/` folder static hosting-এ deploy করলেই Edge Function deploy হয় না; সেটি Supabase CLI দিয়ে আলাদাভাবে deploy করতে হবে।

## নতুন ফিচার

- Admin Student Progress: পরীক্ষা সংখ্যা, মোট নম্বর, গড়, বিষয়ভিত্তিক ফল, Result History, সর্বশেষ পরীক্ষা।
- Student Ranking: মোট scheduled exam marks অনুযায়ী rank; tie হলে একই rank; আগের dashboard snapshot-এর সঙ্গে rank movement।
- Question Bank bulk selection, select all (বর্তমান filter), selection cancel, bulk delete এবং confirmation modal।
- Chapter field ও filter; Exam Builder-এ Question Bank থেকে একাধিক প্রশ্ন এবং নতুন MCQ একসঙ্গে যোগ করা। নতুন MCQ Question Bank-এও save হয়; একই subject-এ একই প্রশ্ন থাকলে duplicate না করে আগেরটি select হয়।
- Exam schedule: Start/End date-time, duration, marks/question, negative marks, random order, publish/unpublish এবং schedule edit। Publish করার আগে Start ও End সময় দিতে হবে।
- Server-side exam attempt: PostgreSQL সময় দিয়ে start/end validation; প্রতিটি selected answer deadline-এর আগে server-এ save হয়; grading database function-এ হয়।
- Answer-key isolation: Student raw `questions`/`exam_questions` table পড়তে পারে না। চলমান/আগামী exam-এর প্রশ্ন practice API-তেও answer key সহ আসে না। Result review exam-এর End date/time পার হওয়ার পর খোলে।
- Username / phone / email login Edge Function দিয়ে; identifier resolution browser-এ email প্রকাশ করে না। Login attempts-এর IP hash-ভিত্তিক rate limit আছে।
- Ranking, result এবং progress print layout; Admin question paper print।
- Responsive UI polish এবং Logout button।

## গুরুত্বপূর্ণ নিয়ম

- নতুন published exam-এর Start ও End date-time নির্ধারণ করতেই হবে। পুরোনো published exam-এর schedule ফাঁকা থাকলে migration created_at থেকে start এবং ৭ দিন পরে end সেট করবে; প্রয়োজন হলে Admin panel থেকে schedule edit করবে।
- Student ranking-এ শুধু scheduled exam result গণনা হয়; একই exam একাধিকবার দিলে ranking-এ সেই exam-এর best score একবারই গণনা হয়। Practice score ranking বাড়ায় না।
- Exam timer-এর সময় Browser timer শুধু display; Server deadline ও answer save-ই authoritative। Browser clock বদলালেও deadline-এর পরে answer save হবে না।
- Practice mode-এ feedback দেওয়ার জন্য কেবল এমন প্রশ্নের answer ফেরত আসে যেগুলো কোনো unclosed exam-এ যুক্ত নয়।
- কোনো service-role key frontend-এ দেওয়া যাবে না।

Student Results page থেকে শুধু Practice history clear করা যাবে; official exam result ranking ও Admin report-এর জন্য অক্ষত থাকবে।

## Test checklist

1. Student account: email confirmation, Remember Me on/off, logout, email/username/phone login।
2. Admin: question create/edit/import, chapter, select all, bulk delete cancel/confirm, duplicate manual question।
3. Exam: draft create, schedule publish, start-এর আগে blocked, active সময়ে start, timer expiry, answer save, result submit, end date পার হওয়ার আগে review blocked, end date পার হলে review visible।
4. Security: Student session দিয়ে `questions` ও `exam_questions` direct select করলে row পাওয়া যাবে না; `get_attempt_questions` response-এ answer/explanation থাকবে না; results direct insert/update/delete ব্যর্থ হবে।
5. Progress/Ranking: একাধিক Student দিয়ে scheduled exam complete করে rank, tie, rank movement এবং Admin progress যাচাই।
6. Mobile: 360px screen-এ Login, Admin Question Bank, Exam Builder, Student leaderboard ও quiz ব্যবহার।
7. Print: Student result/ranking, Admin progress report ও Question Paper A4 preview।

## যাচাই সীমাবদ্ধতা

এই ZIP তৈরি করার সময় JavaScript syntax check করা হয়েছে। তোমার live Supabase project-এ migration, Edge Function deployment, RLS, email delivery বা device/browser flow চালিয়ে দেখা সম্ভব হয়নি। Production-এ দেওয়ার আগে test project-এ checklist চালাবে। SQL migration error ছাড়া শেষ না হলে নতুন frontend deploy করবে না।

## নতুন আপডেট (Bug fix)

1. **Profile সুবিধা চালু করতে:** Supabase → SQL Editor-এ `sql/profile-upgrade.sql` একবার Run করো (ছবি, লেভেল, স্কুল/কলেজ, জেলা Save করার জন্য)।
2. **Exam flow:** Exams → `Participate` চাপলে Popup-এ পরীক্ষার সব তথ্য আসে → `Start exam` চাপলে পরীক্ষা শুরু। প্রশ্ন একটা একটা করে আসে; উত্তর বেছে `Submit answer` চাপলে পরেরটা আসে (Next/Skip/Previous ও প্রশ্ন-নম্বরের তালিকা নেই)।
3. **Profile:** Header-এর Logout বাটনের জায়গায় Profile বাটন। Sign out Profile-এর নিচে আছে।
4. **Admin login:** `admin-login.html` — আলাদা নতুন ডিজাইন; শুধু role=admin ঢুকতে পারে। Student login পেজের নিচে লিংক আছে।
