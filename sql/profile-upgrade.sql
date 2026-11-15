-- MCQ Master — Profile upgrade (Supabase → SQL Editor → paste → Run). বারবার run করা নিরাপদ।
-- Profile page-এর ছবি, লেভেল, স্কুল/কলেজ ও জেলা Save করার জন্য নতুন column।
alter table public.profiles add column if not exists level text;
alter table public.profiles add column if not exists institution text;
alter table public.profiles add column if not exists district text;
alter table public.profiles add column if not exists avatar_url text;  -- ছোট (256px) JPEG data-URL

do $$ begin
  alter table public.profiles add constraint profiles_avatar_size_chk check (avatar_url is null or length(avatar_url) <= 150000);
exception when duplicate_object then null; end $$;

-- Student নিজের এই field-গুলো বদলাতে পারবে; role/email/username আগের মতোই বদলানো যাবে না।
grant update (first_name, last_name, phone, level, institution, district, avatar_url) on public.profiles to authenticated;
