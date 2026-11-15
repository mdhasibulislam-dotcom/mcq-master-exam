# MCQ Master — Feature implementation status

## Project files updated
- `index.html`, `auth.css`, `js/auth.js`: Login/Signup UI and email/username/phone sign-in flow.
- `admin.html`, `admin.css`, `js/admin.js`: student progress detail, bulk question selection/delete, custom exam builder, scheduling editor, question-paper print.
- `student.html`, `student.css`, `js/student.js`: ranking, rank movement, server-side exam attempts, answer saving, grading, review gate and print.
- `js/bulk-import.js`: optional chapter CSV import.
- `sql/feature-upgrade.sql`: database schema, RLS, RPC, grading, ranking, progress and schedule logic.
- `supabase/functions/login-with-identifier/`: secure identifier resolution and login Edge Function.
- `supabase/functions/_shared/cors.ts`: Edge Function CORS helper.
- `README-BN.md`: setup and test instructions.

## Implemented in code
1. Admin student progress and result history.
2. Student rank, position, aggregate marks, average, tie-aware rank, best-score-per-exam aggregation and previous snapshot comparison.
3. Question Bank multi-select, current-filter select-all, cancel, bulk delete confirmation/loading/error/success.
4. Schedule fields and schedule editing.
5. Exam Builder from selected bank questions and manually created bank questions; duplicate check; chapter filter; mark settings; random order.
6. Server-time start validation, server-side per-answer save, server-side grading.
7. Answer key hidden from direct Student table access and hidden from active/unclosed exam question practice RPC; review RPC checks scheduled end time.
8. Remember Me storage mode, no password storage; Email/Username/Phone login via Edge Function.
9. Responsive and print CSS; result, ranking, progress and question paper print actions. Practice history clear is retained while official exam results are protected.

## Required external setup by project owner
- Run `sql/feature-upgrade.sql` in the correct Supabase project after backup.
- Deploy `login-with-identifier` Edge Function using Supabase CLI.
- Verify Edge Function secrets; never expose service-role key in frontend.
- Add Admin role manually with SQL.
- Test Email confirmation, reset-password redirect, all three login identifiers, RLS and exam timing on a test account.

## Not claimed as live-verified
- No access to the owner's live Supabase project was available during code generation.
- SQL migration has not been executed against the user's production database.
- Edge Function has not been deployed or exercised against the live Auth project.
- Mobile browser behavior, email delivery and actual RLS/network payload checks require the owner's test run.

## Security notes
- Student-facing raw `questions` and `exam_questions` table access is blocked by RLS.
- Practice answer key is returned only for questions not attached to an exam whose end time has not passed.
- Exam questions API returns question text/options only.
- Exam answer selections are stored via `save_exam_answer`; `submit_exam` grades stored selections using the database answer key.
- Result insert/update/delete is revoked for normal authenticated clients; grading RPC writes results.
- Result review is gated until the scheduled exam end time.
- Practice results do not affect competitive ranking.
