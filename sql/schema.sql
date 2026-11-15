-- MCQ Master v2 — Supabase SQL Editor-এ পুরোটা paste করে Run করো। বারবার run করা নিরাপদ।
create extension if not exists pgcrypto;

-- ---------- Tables ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  email text unique not null,
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists first_name text not null default 'Student';
alter table public.profiles add column if not exists last_name  text not null default '';
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists role text not null default 'student';
do $$ begin
  alter table public.profiles add constraint profiles_role_chk check (role in ('student','admin'));
exception when duplicate_object then null; end $$;

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  option_a text not null, option_b text not null, option_c text not null, option_d text not null,
  answer smallint not null check (answer between 0 and 3),
  subject text not null,
  created_at timestamptz not null default now()
);
alter table public.questions add column if not exists difficulty text not null default 'Medium';
alter table public.questions add column if not exists tag text not null default '';
alter table public.questions add column if not exists explanation text not null default '';
alter table public.questions add column if not exists created_by uuid references public.profiles(id) on delete set null;
create index if not exists questions_subject_idx on public.questions(subject);

create table if not exists public.exams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  minutes integer not null default 10 check (minutes > 0),
  created_at timestamptz not null default now()
);
alter table public.exams add column if not exists subject text;
alter table public.exams add column if not exists is_published boolean not null default true;
alter table public.exams add column if not exists created_by uuid references public.profiles(id) on delete set null;

create table if not exists public.exam_questions (
  exam_id uuid not null references public.exams(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (exam_id, question_id)
);

create table if not exists public.results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  exam_id uuid references public.exams(id) on delete set null,
  title text not null,
  score integer not null check (score >= 0),
  total integer not null check (total > 0 and score <= total),
  created_at timestamptz not null default now()
);
alter table public.results add column if not exists by_subject jsonb not null default '{}'::jsonb;
alter table public.results add column if not exists answers jsonb;
create index if not exists results_user_created_idx on public.results(user_id, created_at desc);

create table if not exists public.bookmarks (
  user_id uuid not null references public.profiles(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, question_id)
);

-- ---------- New user -> profile ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare uname text;
begin
  uname := lower(coalesce(nullif(new.raw_user_meta_data->>'username',''), split_part(new.email,'@',1)));
  begin
    insert into public.profiles(id,username,first_name,last_name,email,phone)
    values (new.id, uname,
      coalesce(nullif(new.raw_user_meta_data->>'first_name',''),'Student'),
      coalesce(new.raw_user_meta_data->>'last_name',''),
      new.email, nullif(new.raw_user_meta_data->>'phone',''))
    on conflict (id) do nothing;
  exception when unique_violation then
    insert into public.profiles(id,username,first_name,last_name,email,phone)
    values (new.id, 'user_' || substr(replace(new.id::text,'-',''),1,10),
      coalesce(nullif(new.raw_user_meta_data->>'first_name',''),'Student'),
      coalesce(new.raw_user_meta_data->>'last_name',''),
      new.email, nullif(new.raw_user_meta_data->>'phone',''))
    on conflict (id) do nothing;
  end;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- আগে তৈরি হওয়া user-দের profile (SQL run করার আগে sign up করলে লাগে)
insert into public.profiles(id,username,email)
select u.id, 'user_' || substr(replace(u.id::text,'-',''),1,10), u.email
from auth.users u where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict do nothing;

-- ---------- Helpers ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.username_available(u text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists(select 1 from public.profiles where username = lower(u));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------- Row Level Security ----------
alter table public.profiles       enable row level security;
alter table public.questions      enable row level security;
alter table public.exams          enable row level security;
alter table public.exam_questions enable row level security;
alter table public.results        enable row level security;
alter table public.bookmarks      enable row level security;

-- পুরনো সব policy মুছে নতুন সেট বসানো হচ্ছে
do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('profiles','questions','exams','exam_questions','results','bookmarks')
  loop execute format('drop policy %I on public.%I', r.policyname, r.tablename); end loop;
end $$;

-- profiles: নিজেরটা বা admin সবার (email/phone অন্য student দেখবে না)
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy questions_read on public.questions for select to authenticated using (true);
create policy questions_admin on public.questions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy exams_read on public.exams for select to authenticated
  using (is_published or public.is_admin());
create policy exams_admin on public.exams for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy exam_questions_read on public.exam_questions for select to authenticated
  using (public.is_admin() or exists (select 1 from public.exams e where e.id = exam_id and e.is_published));
create policy exam_questions_admin on public.exam_questions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy results_read on public.results for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy results_insert on public.results for insert to authenticated
  with check (user_id = auth.uid());
create policy results_delete on public.results for delete to authenticated
  using (user_id = auth.uid());

create policy bookmarks_own on public.bookmarks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- Grants (column-level: student role/email/username বদলাতে পারবে না) ----------
grant usage on schema public to authenticated, anon;
revoke all on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update (first_name, last_name, phone) on public.profiles to authenticated;
grant select, insert, update, delete on public.questions, public.exams, public.exam_questions to authenticated;
grant select, insert, delete on public.results, public.bookmarks to authenticated;
