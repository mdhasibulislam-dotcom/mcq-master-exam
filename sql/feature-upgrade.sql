-- MCQ MASTER: Feature upgrade migration
-- Run AFTER sql/schema.sql. Safe to re-run on the same project.
create extension if not exists pgcrypto;

-- 1) Schema additions
alter table public.questions add column if not exists chapter text not null default '';
alter table public.exams add column if not exists start_at timestamptz;
alter table public.exams add column if not exists end_at timestamptz;
alter table public.exams add column if not exists marks_per_question numeric(7,2) not null default 1;
alter table public.exams add column if not exists negative_mark numeric(7,2) not null default 0;
alter table public.exams add column if not exists randomize_questions boolean not null default true;
alter table public.exams add column if not exists allow_review boolean not null default true;
alter table public.results add column if not exists attempt_id uuid;
alter table public.results alter column score type numeric(10,2) using score::numeric;
alter table public.results alter column total type numeric(10,2) using total::numeric;

create index if not exists questions_subject_chapter_idx on public.questions(subject, chapter);
create index if not exists exams_schedule_idx on public.exams(is_published, start_at, end_at);

-- Existing rows: normalize identifiers and resolve legacy case-insensitive duplicates safely.
with ranked as (
  select id, row_number() over(partition by lower(trim(username)) order by created_at nulls last,id) rn
  from public.profiles
)
update public.profiles p set username = case when r.rn=1 then lower(trim(p.username)) else 'user_'||substr(replace(p.id::text,'-',''),1,10) end
from ranked r where p.id=r.id;
with duplicate_phones as (
  select id,row_number() over(partition by phone order by created_at nulls last,id) rn
  from public.profiles where phone is not null and phone<>''
)
update public.profiles p set phone=null from duplicate_phones d where p.id=d.id and d.rn>1;
create unique index if not exists profiles_username_lower_uidx on public.profiles (lower(username));
create unique index if not exists profiles_phone_unique_idx on public.profiles (phone) where phone is not null and phone <> '';

-- 2) Exam attempts: start and deadline are decided by PostgreSQL time, not browser time.
create table if not exists public.exam_attempts (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references public.exams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  submitted_at timestamptz,
  result_id uuid references public.results(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists exam_attempts_user_idx on public.exam_attempts(user_id, created_at desc);

alter table public.exam_attempts enable row level security;
drop policy if exists exam_attempts_own_read on public.exam_attempts;
drop policy if exists exam_attempts_admin_read on public.exam_attempts;
create policy exam_attempts_own_read on public.exam_attempts for select to authenticated using (user_id = auth.uid() or public.is_admin());
revoke all on public.exam_attempts from anon, authenticated;
grant select on public.exam_attempts to authenticated;

-- 3) Harden direct table access. Answer keys are only returned by narrowly scoped RPCs.
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='questions'
  loop execute format('drop policy %I on public.questions', p.policyname); end loop;
end $$;
create policy questions_admin_only on public.questions for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Exam mapping is hidden from students; they receive a safe projection through RPC.
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='exam_questions'
  loop execute format('drop policy %I on public.exam_questions', p.policyname); end loop;
end $$;
create policy exam_questions_admin_only on public.exam_questions for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Students cannot forge or erase their own grades. Only grading RPC inserts results.
drop policy if exists results_insert on public.results;
drop policy if exists results_delete on public.results;
revoke insert, update, delete on public.results from authenticated;
grant select on public.results to authenticated;

-- Admins can update exam schedules; students only read published exam metadata.
-- Existing exams policies already enforce this. Add a validation trigger for schedule consistency.
create or replace function public.validate_exam_schedule()
returns trigger language plpgsql as $$
begin
  if new.minutes < 1 then raise exception 'Exam duration must be at least one minute'; end if;
  if new.start_at is not null and new.end_at is not null and new.end_at <= new.start_at then
    raise exception 'Exam end time must be after start time';
  end if;
  if new.marks_per_question <= 0 or new.negative_mark < 0 then
    raise exception 'Invalid marks configuration';
  end if;
  return new;
end $$;
drop trigger if exists exams_validate_schedule on public.exams;
create trigger exams_validate_schedule before insert or update on public.exams
for each row execute function public.validate_exam_schedule();

-- 4) Safe question access for practice (answers are intentionally available only in practice mode).
create or replace function public.get_practice_questions(
  p_subject text default null, p_chapter text default null, p_difficulty text default null, p_limit integer default 100
) returns jsonb language plpgsql security definer set search_path=public as $$
declare out_json jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into out_json from (
    select id, text, option_a, option_b, option_c, option_d, answer, explanation, subject, chapter, difficulty, tag
    from public.questions
    where (p_subject is null or subject = p_subject)
      and (p_chapter is null or chapter = p_chapter)
      and (p_difficulty is null or difficulty = p_difficulty)
    order by created_at desc limit greatest(1, least(coalesce(p_limit,100),500))
  ) x;
  return out_json;
end $$;
grant execute on function public.get_practice_questions(text,text,text,integer) to authenticated;

-- 5) Student-safe exam metadata and question projection (NO answer / explanation).
create or replace function public.get_student_exams()
returns table(id uuid, name text, subject text, minutes integer, start_at timestamptz, end_at timestamptz,
              marks_per_question numeric, negative_mark numeric, question_count bigint)
language sql security definer set search_path=public as $$
  select e.id,e.name,e.subject,e.minutes,e.start_at,e.end_at,e.marks_per_question,e.negative_mark,
         count(eq.question_id) as question_count
  from public.exams e left join public.exam_questions eq on eq.exam_id=e.id
  where e.is_published = true and auth.uid() is not null
  group by e.id order by e.created_at desc;
$$;
grant execute on function public.get_student_exams() to authenticated;

create or replace function public.start_exam(p_exam_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.exams%rowtype; attempt public.exam_attempts%rowtype; now_at timestamptz := clock_timestamp();
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into e from public.exams where id=p_exam_id and is_published=true;
  if not found then raise exception 'পরীক্ষাটি পাওয়া যায়নি বা প্রকাশিত নয়'; end if;
  if e.start_at is not null and now_at < e.start_at then raise exception 'পরীক্ষা এখনো শুরু হয়নি'; end if;
  if e.end_at is not null and now_at >= e.end_at then raise exception 'পরীক্ষার সময় শেষ'; end if;
  insert into public.exam_attempts(exam_id,user_id,started_at,ends_at)
  values(e.id,auth.uid(),now_at,least(now_at + make_interval(mins => e.minutes), coalesce(e.end_at,'infinity'::timestamptz)))
  returning * into attempt;
  return jsonb_build_object('attempt_id',attempt.id,'started_at',attempt.started_at,'ends_at',attempt.ends_at,
    'server_now',now_at,'exam_id',e.id,'name',e.name,'minutes',e.minutes,'marks_per_question',e.marks_per_question,
    'negative_mark',e.negative_mark,'allow_review',e.allow_review);
end $$;
grant execute on function public.start_exam(uuid) to authenticated;

create or replace function public.get_attempt_questions(p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.exam_attempts%rowtype; e public.exams%rowtype; out_json jsonb;
begin
  select * into a from public.exam_attempts where id=p_attempt_id and user_id=auth.uid();
  if not found or a.submitted_at is not null then raise exception 'পরীক্ষার attempt পাওয়া যায়নি বা ইতিমধ্যে জমা হয়েছে'; end if;
  select * into e from public.exams where id=a.exam_id;
  if clock_timestamp() > a.ends_at then raise exception 'পরীক্ষার সময় শেষ'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_order), '[]'::jsonb) into out_json from (
    select q.id,q.text,q.option_a,q.option_b,q.option_c,q.option_d,q.subject,q.chapter,q.difficulty,eq.sort_order
    from public.exam_questions eq join public.questions q on q.id=eq.question_id
    where eq.exam_id=a.exam_id
    order by case when e.randomize_questions then random() else eq.sort_order end
  ) x;
  return out_json;
end $$;
grant execute on function public.get_attempt_questions(uuid) to authenticated;

-- 6) Server-side grading. Client sends selected option only; correct answer never comes back here.
create or replace function public.submit_exam(p_attempt_id uuid, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.exam_attempts%rowtype; e public.exams%rowtype; total_n integer; score_n numeric(10,2) := 0;
  correct_n integer := 0; subject_stats jsonb := '{}'::jsonb; answer_rows jsonb; item record; selected_n integer;
  result_row public.results%rowtype; now_at timestamptz := clock_timestamp();
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into a from public.exam_attempts where id=p_attempt_id and user_id=auth.uid() for update;
  if not found or a.submitted_at is not null then raise exception 'এই পরীক্ষা ইতিমধ্যে জমা হয়েছে বা পাওয়া যায়নি'; end if;
  select * into e from public.exams where id=a.exam_id;
  if now_at > a.ends_at then raise exception 'Server timer expired'; end if;
  if e.end_at is not null and now_at > e.end_at then raise exception 'পরীক্ষার নির্ধারিত সময় শেষ'; end if;
  select count(*) into total_n from public.exam_questions where exam_id=e.id;
  if total_n < 1 then raise exception 'এই পরীক্ষায় কোনো প্রশ্ন নেই'; end if;
  if jsonb_typeof(p_answers) <> 'array' then raise exception 'Invalid answer payload'; end if;
  for item in
    select q.id,q.answer,q.subject, x.value->>'selected' as selected
    from public.exam_questions eq join public.questions q on q.id=eq.question_id
    left join jsonb_array_elements(p_answers) x(value) on (x.value->>'question_id')::uuid=q.id
    where eq.exam_id=e.id
  loop
    selected_n := nullif(item.selected,'')::integer;
    if selected_n is not null and (selected_n < 0 or selected_n > 3) then raise exception 'Invalid selected option'; end if;
    if selected_n = item.answer then correct_n := correct_n + 1; score_n := score_n + e.marks_per_question;
    elsif selected_n is not null then score_n := score_n - e.negative_mark; end if;
    subject_stats := jsonb_set(subject_stats, array[item.subject],
      coalesce(subject_stats->item.subject,'{"correct":0,"total":0,"score":0}'::jsonb) ||
      jsonb_build_object('correct',coalesce((subject_stats->item.subject->>'correct')::int,0) + case when selected_n=item.answer then 1 else 0 end,
                         'total',coalesce((subject_stats->item.subject->>'total')::int,0)+1,
                         'score',coalesce((subject_stats->item.subject->>'score')::numeric,0)+case when selected_n=item.answer then e.marks_per_question when selected_n is not null then -e.negative_mark else 0 end), true);
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('question_id',q.id,'selected',nullif(x.value->>'selected','')::integer)), '[]'::jsonb)
  into answer_rows from public.exam_questions eq join public.questions q on q.id=eq.question_id
  left join jsonb_array_elements(p_answers) x(value) on (x.value->>'question_id')::uuid=q.id where eq.exam_id=e.id;
  insert into public.results(user_id,exam_id,title,score,total,by_subject,answers,attempt_id)
  values(auth.uid(),e.id,e.name,greatest(0,round(score_n,2)),total_n*e.marks_per_question,subject_stats,answer_rows,a.id)
  returning * into result_row;
  update public.exam_attempts set submitted_at=now_at,result_id=result_row.id where id=a.id;
  return jsonb_build_object('id',result_row.id,'title',result_row.title,'score',result_row.score,'total',result_row.total,
    'by_subject',result_row.by_subject,'created_at',result_row.created_at,'percentage',round((result_row.score::numeric/nullif(result_row.total,0))*100,2));
end $$;
grant execute on function public.submit_exam(uuid,jsonb) to authenticated;

-- Practice grading is also server-calculated, although instant practice deliberately exposes the key.
create or replace function public.submit_practice(p_answers jsonb, p_title text default 'Practice')
returns jsonb language plpgsql security definer set search_path=public as $$
declare total_n integer; score_n integer := 0; by_sub jsonb := '{}'::jsonb; item record; sel integer; out_answers jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_answers) <> 'array' then raise exception 'Invalid answers'; end if;
  for item in select q.id,q.answer,q.subject,x.value->>'selected' selected from jsonb_array_elements(p_answers) x(value)
    join public.questions q on q.id=(x.value->>'question_id')::uuid loop
    sel := nullif(item.selected,'')::integer;
    if sel is not null and sel=item.answer then score_n:=score_n+1; end if;
    by_sub := jsonb_set(by_sub,array[item.subject],coalesce(by_sub->item.subject,'{"correct":0,"total":0}'::jsonb)||
      jsonb_build_object('correct',coalesce((by_sub->item.subject->>'correct')::int,0)+case when sel=item.answer then 1 else 0 end,
                         'total',coalesce((by_sub->item.subject->>'total')::int,0)+1),true);
  end loop;
  select count(*) into total_n from jsonb_array_elements(p_answers);
  if total_n<1 then raise exception 'No answers'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('question_id',x.value->>'question_id','selected',nullif(x.value->>'selected','')::integer)), '[]'::jsonb)
  into out_answers from jsonb_array_elements(p_answers) x(value);
  insert into public.results(user_id,title,score,total,by_subject,answers) values(auth.uid(),p_title,score_n,total_n,by_sub,out_answers)
  returning jsonb_build_object('id',id,'title',title,'score',score,'total',total,'by_subject',by_subject,'answers',answers,'created_at',created_at) into out_answers;
  return out_answers;
end $$;
grant execute on function public.submit_practice(jsonb,text) to authenticated;

-- 7) Answer key and explanations are revealed only after the scheduled exam closes.
create or replace function public.get_result_review(p_result_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.results%rowtype; e public.exams%rowtype; out_json jsonb;
begin
  select * into r from public.results where id=p_result_id and (user_id=auth.uid() or public.is_admin());
  if not found then raise exception 'Result পাওয়া যায়নি'; end if;
  if r.exam_id is not null then
    select * into e from public.exams where id=r.exam_id;
    if e.end_at is not null and clock_timestamp() < e.end_at then raise exception 'নির্ধারিত পরীক্ষা শেষ হওয়ার আগে Answer Key দেখা যাবে না'; end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('question_id',q.id,'text',q.text,'option_a',q.option_a,'option_b',q.option_b,
    'option_c',q.option_c,'option_d',q.option_d,'answer',q.answer,'explanation',q.explanation,'subject',q.subject,
    'selected', (a.value->>'selected')::integer) order by q.created_at), '[]'::jsonb) into out_json
  from jsonb_array_elements(coalesce(r.answers,'[]'::jsonb)) a(value)
  join public.questions q on q.id=(a.value->>'question_id')::uuid;
  return jsonb_build_object('result_id',r.id,'title',r.title,'score',r.score,'total',r.total,'answers',out_json,'by_subject',r.by_subject,'created_at',r.created_at);
end $$;
grant execute on function public.get_result_review(uuid) to authenticated;

-- 8) Student aggregate and tie-aware ranking (rank() gives equal rank for ties).
create or replace function public.get_student_dashboard()
returns jsonb language plpgsql security definer set search_path=public as $$
declare me_id uuid:=auth.uid(); mine jsonb; board jsonb;
begin
  if me_id is null then raise exception 'Authentication required'; end if;
  with totals as (
    select p.id,p.username,p.first_name,p.last_name,coalesce(sum(r.score),0)::numeric total_score,
      count(r.id)::integer tests,coalesce(sum(r.total),0)::integer total_questions,
      coalesce(avg(case when r.total>0 then r.score::numeric/r.total*100 end),0)::numeric avg_percent
    from public.profiles p left join public.results r on r.user_id=p.id
    where p.role='student' group by p.id
  ), ranked as (select *,rank() over(order by total_score desc) rank_no,count(*) over() student_count from totals)
  select to_jsonb(x) into mine from ranked x where id=me_id;
  with totals as (
    select p.id,p.username,p.first_name,p.last_name,coalesce(sum(r.score),0)::numeric total_score,
      count(r.id)::integer tests,coalesce(avg(case when r.total>0 then r.score::numeric/r.total*100 end),0)::numeric avg_percent
    from public.profiles p left join public.results r on r.user_id=p.id
    where p.role='student' group by p.id
  ), ranked as (select *,rank() over(order by total_score desc) rank_no from totals)
  select coalesce(jsonb_agg(to_jsonb(x) order by rank_no,total_score desc),'[]'::jsonb) into board from (select * from ranked order by rank_no,total_score desc limit 100) x;
  return jsonb_build_object('me',mine,'leaderboard',board);
end $$;
grant execute on function public.get_student_dashboard() to authenticated;

create or replace function public.admin_student_progress(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.profiles%rowtype; summary jsonb; history jsonb; subjects jsonb;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select * into u from public.profiles where id=p_user_id and role='student';
  if not found then raise exception 'Student পাওয়া যায়নি'; end if;
  select jsonb_build_object('tests',count(*),'score',coalesce(sum(score),0),'total',coalesce(sum(total),0),
    'average_percent',coalesce(avg(score::numeric/nullif(total,0)*100),0),'last_exam',max(created_at)) into summary
  from public.results where user_id=p_user_id and exam_id is not null;
  select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc),'[]'::jsonb) into history
  from (select id,title,score,total,by_subject,created_at from public.results where user_id=p_user_id order by created_at desc limit 100) x;
  select coalesce(jsonb_object_agg(subject,json),'{}'::jsonb) into subjects from (
    select key subject,jsonb_build_object('correct',sum((value->>'correct')::numeric),'total',sum((value->>'total')::numeric)) json
    from public.results r cross join lateral jsonb_each(r.by_subject) where r.user_id=p_user_id group by key
  ) s;
  return jsonb_build_object('student',to_jsonb(u),'summary',summary,'history',history,'subjects',subjects);
end $$;
grant execute on function public.admin_student_progress(uuid) to authenticated;

-- 9) Atomic exam builder. Question IDs must exist; duplicates are removed.
create or replace function public.admin_create_exam(p_exam jsonb, p_question_ids uuid[])
returns uuid language plpgsql security definer set search_path=public as $$
declare new_id uuid;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if coalesce(array_length(p_question_ids,1),0)<1 then raise exception 'কমপক্ষে একটি প্রশ্ন নির্বাচন করো'; end if;
  insert into public.exams(name,subject,minutes,is_published,created_by,start_at,end_at,marks_per_question,negative_mark,randomize_questions,allow_review)
  values(p_exam->>'name',nullif(p_exam->>'subject',''),(p_exam->>'minutes')::int,coalesce((p_exam->>'is_published')::boolean,false),auth.uid(),
    nullif(p_exam->>'start_at','')::timestamptz,nullif(p_exam->>'end_at','')::timestamptz,
    coalesce((p_exam->>'marks_per_question')::numeric,1),coalesce((p_exam->>'negative_mark')::numeric,0),
    coalesce((p_exam->>'randomize_questions')::boolean,true),coalesce((p_exam->>'allow_review')::boolean,true)) returning id into new_id;
  insert into public.exam_questions(exam_id,question_id,sort_order)
  select new_id,id,row_number() over(order by id)-1 from (select distinct unnest(p_question_ids) id) x;
  return new_id;
end $$;
grant execute on function public.admin_create_exam(jsonb,uuid[]) to authenticated;

-- 10) Admin question bank delete uses existing admin-only policy. Ensure RLS grants are explicit.
grant select, insert, update, delete on public.questions, public.exams, public.exam_questions to authenticated;
grant select on public.profiles to authenticated;

-- Identifier login resolves inside Edge Function only. This RPC is NOT exposed to anon.
-- Do not create a public email/phone lookup function.

-- NOTE: Existing legacy results.answers may contain a `correct` key from the old client.
-- Strip that key so historical result rows do not leak old answer keys via table SELECT.
update public.results set answers = (
  select coalesce(jsonb_agg(jsonb_build_object('question_id',x.value->>'question_id','selected',nullif(x.value->>'selected','')::integer)), '[]'::jsonb)
  from jsonb_array_elements(coalesce(answers,'[]'::jsonb)) x(value)
) where answers is not null;

-- 11) Per-answer server writes prevent changing answers after the server deadline.
create table if not exists public.exam_attempt_answers (
  attempt_id uuid not null references public.exam_attempts(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  selected smallint check (selected between 0 and 3),
  updated_at timestamptz not null default now(),
  primary key(attempt_id,question_id)
);
alter table public.exam_attempt_answers enable row level security;
revoke all on public.exam_attempt_answers from anon, authenticated;

create or replace function public.save_exam_answer(p_attempt_id uuid,p_question_id uuid,p_selected smallint)
returns boolean language plpgsql security definer set search_path=public as $$
declare a public.exam_attempts%rowtype; belongs boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_selected is not null and (p_selected<0 or p_selected>3) then raise exception 'Invalid option'; end if;
  select * into a from public.exam_attempts where id=p_attempt_id and user_id=auth.uid() and submitted_at is null;
  if not found then raise exception 'Attempt not found or already submitted'; end if;
  if clock_timestamp()>a.ends_at then raise exception 'Server timer expired'; end if;
  select exists(select 1 from public.exam_questions where exam_id=a.exam_id and question_id=p_question_id) into belongs;
  if not belongs then raise exception 'Question does not belong to this exam'; end if;
  insert into public.exam_attempt_answers(attempt_id,question_id,selected) values(p_attempt_id,p_question_id,p_selected)
  on conflict(attempt_id,question_id) do update set selected=excluded.selected,updated_at=clock_timestamp();
  return true;
end $$;
grant execute on function public.save_exam_answer(uuid,uuid,smallint) to authenticated;

drop function if exists public.submit_exam(uuid,jsonb);
create or replace function public.submit_exam(p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.exam_attempts%rowtype; e public.exams%rowtype; total_n integer; score_n numeric(10,2):=0;
  correct_n integer:=0; subject_stats jsonb:='{}'::jsonb; answer_rows jsonb; item record; selected_n integer;
  result_row public.results%rowtype; now_at timestamptz:=clock_timestamp();
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into a from public.exam_attempts where id=p_attempt_id and user_id=auth.uid() for update;
  if not found or a.submitted_at is not null then raise exception 'এই পরীক্ষা ইতিমধ্যে জমা হয়েছে বা পাওয়া যায়নি'; end if;
  select * into e from public.exams where id=a.exam_id;
  -- Submission is allowed after the timer only for the answers already saved before deadline.
  select count(*) into total_n from public.exam_questions where exam_id=e.id;
  if total_n<1 then raise exception 'এই পরীক্ষায় কোনো প্রশ্ন নেই'; end if;
  for item in select q.id,q.answer,q.subject,aa.selected from public.exam_questions eq join public.questions q on q.id=eq.question_id
    left join public.exam_attempt_answers aa on aa.attempt_id=a.id and aa.question_id=q.id where eq.exam_id=e.id loop
    selected_n:=item.selected;
    if selected_n=item.answer then correct_n:=correct_n+1;score_n:=score_n+e.marks_per_question;
    elsif selected_n is not null then score_n:=score_n-e.negative_mark;end if;
    subject_stats:=jsonb_set(subject_stats,array[item.subject],coalesce(subject_stats->item.subject,'{"correct":0,"total":0,"score":0}'::jsonb)||
      jsonb_build_object('correct',coalesce((subject_stats->item.subject->>'correct')::int,0)+case when selected_n=item.answer then 1 else 0 end,
      'total',coalesce((subject_stats->item.subject->>'total')::int,0)+1,
      'score',coalesce((subject_stats->item.subject->>'score')::numeric,0)+case when selected_n=item.answer then e.marks_per_question when selected_n is not null then -e.negative_mark else 0 end),true);
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('question_id',eq.question_id,'selected',aa.selected) order by eq.sort_order),'[]'::jsonb)
  into answer_rows from public.exam_questions eq left join public.exam_attempt_answers aa on aa.attempt_id=a.id and aa.question_id=eq.question_id where eq.exam_id=e.id;
  insert into public.results(user_id,exam_id,title,score,total,by_subject,answers,attempt_id)
  values(auth.uid(),e.id,e.name,greatest(0,round(score_n,2)),total_n*e.marks_per_question,subject_stats,answer_rows,a.id) returning * into result_row;
  update public.exam_attempts set submitted_at=now_at,result_id=result_row.id where id=a.id;
  return jsonb_build_object('id',result_row.id,'title',result_row.title,'score',result_row.score,'total',result_row.total,
    'by_subject',result_row.by_subject,'created_at',result_row.created_at,'percentage',round((result_row.score::numeric/nullif(result_row.total,0))*100,2));
end $$;
grant execute on function public.submit_exam(uuid) to authenticated;


-- Login Edge Function rate-limit storage. Only service_role may access this table.
create table if not exists public.login_attempts (
  id bigserial primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists login_attempts_ip_time_idx on public.login_attempts(ip_hash,created_at desc);
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon,authenticated;


-- Ensure question randomization is reflected in the returned array order.
create or replace function public.get_attempt_questions(p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.exam_attempts%rowtype; e public.exams%rowtype; out_json jsonb;
begin
  select * into a from public.exam_attempts where id=p_attempt_id and user_id=auth.uid();
  if not found or a.submitted_at is not null then raise exception 'পরীক্ষার attempt পাওয়া যায়নি বা ইতিমধ্যে জমা হয়েছে'; end if;
  select * into e from public.exams where id=a.exam_id;
  if clock_timestamp()>a.ends_at then raise exception 'পরীক্ষার সময় শেষ'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.display_order),'[]'::jsonb) into out_json from (
    select q.id,q.text,q.option_a,q.option_b,q.option_c,q.option_d,q.subject,q.chapter,q.difficulty,
      row_number() over(order by case when e.randomize_questions then random() else eq.sort_order::double precision end) display_order
    from public.exam_questions eq join public.questions q on q.id=eq.question_id where eq.exam_id=a.exam_id
  ) x;
  return out_json;
end $$;
grant execute on function public.get_attempt_questions(uuid) to authenticated;

-- 12) Ranking snapshots: show rank movement since the previous dashboard visit.
create table if not exists public.ranking_snapshots (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  rank_no bigint not null,
  snapshot_at timestamptz not null default now()
);
create index if not exists ranking_snapshots_user_time_idx on public.ranking_snapshots(user_id,snapshot_at desc);
alter table public.ranking_snapshots enable row level security;
revoke all on public.ranking_snapshots from anon,authenticated;

create or replace function public.get_student_dashboard()
returns jsonb language plpgsql security definer set search_path=public as $$
declare me_id uuid:=auth.uid(); mine jsonb; board jsonb; old_rank bigint; new_rank bigint;
begin
  if me_id is null then raise exception 'Authentication required'; end if;
  select rank_no into old_rank from public.ranking_snapshots where user_id=me_id order by snapshot_at desc limit 1;
  with totals as (
    select p.id,p.username,p.first_name,p.last_name,coalesce(sum(r.score),0)::numeric total_score,
      count(r.id)::integer tests,coalesce(sum(r.total),0)::numeric total_questions,
      coalesce(avg(case when r.total>0 then r.score::numeric/r.total*100 end),0)::numeric avg_percent
    from public.profiles p left join public.results r on r.user_id=p.id and r.exam_id is not null where p.role='student' group by p.id
  ), ranked as (select *,rank() over(order by total_score desc) rank_no,count(*) over() student_count from totals)
  select to_jsonb(x),x.rank_no into mine,new_rank from ranked x where id=me_id;
  if mine is null then raise exception 'Student profile পাওয়া যায়নি'; end if;
  mine:=mine||jsonb_build_object('rank_change',case when old_rank is null then 0 else old_rank-new_rank end,'previous_rank',old_rank);
  with totals as (
    select p.id,p.username,p.first_name,p.last_name,coalesce(sum(r.score),0)::numeric total_score,
      count(r.id)::integer tests,coalesce(avg(case when r.total>0 then r.score::numeric/r.total*100 end),0)::numeric avg_percent
    from public.profiles p left join public.results r on r.user_id=p.id and r.exam_id is not null where p.role='student' group by p.id
  ), ranked as (select *,rank() over(order by total_score desc) rank_no from totals)
  select coalesce(jsonb_agg(to_jsonb(x) order by rank_no,total_score desc),'[]'::jsonb) into board
  from (select * from ranked order by rank_no,total_score desc limit 100) x;
  insert into public.ranking_snapshots(user_id,rank_no)
  select p.id,rank() over(order by coalesce(sum(r.score),0) desc)
  from public.profiles p left join public.results r on r.user_id=p.id and r.exam_id is not null where p.role='student' group by p.id;
  return jsonb_build_object('me',mine,'leaderboard',board);
end $$;
grant execute on function public.get_student_dashboard() to authenticated;

-- Preserve the exact question order in result review.
create or replace function public.get_result_review(p_result_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.results%rowtype; e public.exams%rowtype; out_json jsonb;
begin
  select * into r from public.results where id=p_result_id and (user_id=auth.uid() or public.is_admin());
  if not found then raise exception 'Result পাওয়া যায়নি'; end if;
  if r.exam_id is not null then
    select * into e from public.exams where id=r.exam_id;
    if e.end_at is not null and clock_timestamp()<e.end_at then raise exception 'নির্ধারিত পরীক্ষা শেষ হওয়ার আগে Answer Key দেখা যাবে না'; end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('question_id',q.id,'text',q.text,'option_a',q.option_a,'option_b',q.option_b,
    'option_c',q.option_c,'option_d',q.option_d,'answer',q.answer,'explanation',q.explanation,'subject',q.subject,
    'selected',(a.value->>'selected')::integer) order by a.ord),'[]'::jsonb) into out_json
  from jsonb_array_elements(coalesce(r.answers,'[]'::jsonb)) with ordinality a(value,ord)
  join public.questions q on q.id=(a.value->>'question_id')::uuid;
  return jsonb_build_object('result_id',r.id,'title',r.title,'score',r.score,'total',r.total,'answers',out_json,'by_subject',r.by_subject,'created_at',r.created_at);
end $$;
grant execute on function public.get_result_review(uuid) to authenticated;

-- 13) A published exam must have a defined closing time; practice API withholds
-- keys for every question assigned to an exam whose review window has not closed.
update public.exams set start_at=coalesce(start_at,created_at), end_at=coalesce(end_at,created_at+interval '7 days')
where is_published=true and (start_at is null or end_at is null);

create or replace function public.validate_exam_schedule()
returns trigger language plpgsql as $$
begin
  if new.minutes<1 then raise exception 'Exam duration must be at least one minute'; end if;
  if new.start_at is not null and new.end_at is not null and new.end_at<=new.start_at then
    raise exception 'Exam end time must be after start time';
  end if;
  if new.marks_per_question<=0 or new.negative_mark<0 then raise exception 'Invalid marks configuration'; end if;
  if new.is_published and (new.start_at is null or new.end_at is null) then
    raise exception 'Publish করার আগে Exam Start ও End date/time নির্ধারণ করো';
  end if;
  return new;
end $$;
drop trigger if exists exams_validate_schedule on public.exams;
create trigger exams_validate_schedule before insert or update on public.exams
for each row execute function public.validate_exam_schedule();

create or replace function public.get_practice_questions(
  p_subject text default null,p_chapter text default null,p_difficulty text default null,p_limit integer default 100
) returns jsonb language plpgsql security definer set search_path=public as $$
declare out_json jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into out_json from (
    select q.id,q.text,q.option_a,q.option_b,q.option_c,q.option_d,q.answer,q.explanation,q.subject,q.chapter,q.difficulty,q.tag
    from public.questions q
    where (p_subject is null or q.subject=p_subject) and (p_chapter is null or q.chapter=p_chapter)
      and (p_difficulty is null or q.difficulty=p_difficulty)
      and not exists(select 1 from public.exam_questions eq join public.exams e on e.id=eq.exam_id
        where eq.question_id=q.id and e.is_published=true and (e.end_at is null or clock_timestamp()<e.end_at))
    order by q.created_at desc limit greatest(1,least(coalesce(p_limit,100),500))
  ) x;
  return out_json;
end $$;
grant execute on function public.get_practice_questions(text,text,text,integer) to authenticated;

create or replace function public.get_result_review(p_result_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.results%rowtype; e public.exams%rowtype; out_json jsonb;
begin
  select * into r from public.results where id=p_result_id and (user_id=auth.uid() or public.is_admin());
  if not found then raise exception 'Result পাওয়া যায়নি'; end if;
  if r.exam_id is not null then
    select * into e from public.exams where id=r.exam_id;
    if e.end_at is null or clock_timestamp()<e.end_at then raise exception 'নির্ধারিত Exam End date/time-এর আগে Answer Key দেখা যাবে না'; end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('question_id',q.id,'text',q.text,'option_a',q.option_a,'option_b',q.option_b,
    'option_c',q.option_c,'option_d',q.option_d,'answer',q.answer,'explanation',q.explanation,'subject',q.subject,
    'selected',(a.value->>'selected')::integer) order by a.ord),'[]'::jsonb) into out_json
  from jsonb_array_elements(coalesce(r.answers,'[]'::jsonb)) with ordinality a(value,ord)
  join public.questions q on q.id=(a.value->>'question_id')::uuid;
  return jsonb_build_object('result_id',r.id,'title',r.title,'score',r.score,'total',r.total,'answers',out_json,'by_subject',r.by_subject,'created_at',r.created_at);
end $$;
grant execute on function public.get_result_review(uuid) to authenticated;

-- 14) Practice RPC must not expose or grade questions assigned to an exam whose key is still sealed.
create or replace function public.submit_practice(p_answers jsonb,p_title text default 'Practice')
returns jsonb language plpgsql security definer set search_path=public as $$
declare total_n integer; score_n integer:=0; by_sub jsonb:='{}'::jsonb; item record; sel integer; out_result jsonb; distinct_n integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_answers)<>'array' then raise exception 'Invalid answers'; end if;
  select count(*),count(distinct value->>'question_id') into total_n,distinct_n from jsonb_array_elements(p_answers);
  if total_n<1 or total_n<>distinct_n then raise exception 'প্রশ্নের তালিকা খালি বা duplicate'; end if;
  for item in
    select q.id,q.answer,q.subject,x.value->>'selected' selected
    from jsonb_array_elements(p_answers) x(value) join public.questions q on q.id=(x.value->>'question_id')::uuid
    where not exists(select 1 from public.exam_questions eq join public.exams e on e.id=eq.exam_id
      where eq.question_id=q.id and (e.end_at is null or clock_timestamp()<e.end_at))
  loop
    sel:=nullif(item.selected,'')::integer;
    if sel is not null and (sel<0 or sel>3) then raise exception 'Invalid selected option'; end if;
    if sel=item.answer then score_n:=score_n+1; end if;
    by_sub:=jsonb_set(by_sub,array[item.subject],coalesce(by_sub->item.subject,'{"correct":0,"total":0}'::jsonb)||
      jsonb_build_object('correct',coalesce((by_sub->item.subject->>'correct')::int,0)+case when sel=item.answer then 1 else 0 end,
      'total',coalesce((by_sub->item.subject->>'total')::int,0)+1),true);
  end loop;
  if (select count(*) from jsonb_array_elements(p_answers) x(value) join public.questions q on q.id=(x.value->>'question_id')::uuid
      where not exists(select 1 from public.exam_questions eq join public.exams e on e.id=eq.exam_id where eq.question_id=q.id and (e.end_at is null or clock_timestamp()<e.end_at)))<>total_n then
    raise exception 'Exam-এর প্রশ্ন Practice result-এ ব্যবহার করা যাবে না';
  end if;
  insert into public.results(user_id,title,score,total,by_subject,answers)
  values(auth.uid(),coalesce(nullif(p_title,''),'Practice'),score_n,total_n,by_sub,
    (select coalesce(jsonb_agg(jsonb_build_object('question_id',x.value->>'question_id','selected',nullif(x.value->>'selected','')::integer)),'[]'::jsonb) from jsonb_array_elements(p_answers) x(value)))
  returning jsonb_build_object('id',id,'title',title,'score',score,'total',total,'by_subject',by_subject,'created_at',created_at) into out_result;
  return out_result;
end $$;
grant execute on function public.submit_practice(jsonb,text) to authenticated;

-- Keep the public practice pool sealed for every question linked to any exam not yet closed.
create or replace function public.get_practice_questions(
  p_subject text default null,p_chapter text default null,p_difficulty text default null,p_limit integer default 100
) returns jsonb language plpgsql security definer set search_path=public as $$
declare out_json jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into out_json from (
    select q.id,q.text,q.option_a,q.option_b,q.option_c,q.option_d,q.answer,q.explanation,q.subject,q.chapter,q.difficulty,q.tag
    from public.questions q where (p_subject is null or q.subject=p_subject) and (p_chapter is null or q.chapter=p_chapter)
      and (p_difficulty is null or q.difficulty=p_difficulty)
      and not exists(select 1 from public.exam_questions eq join public.exams e on e.id=eq.exam_id
        where eq.question_id=q.id and (e.end_at is null or clock_timestamp()<e.end_at))
    order by q.created_at desc limit greatest(1,least(coalesce(p_limit,100),500))
  ) x;
  return out_json;
end $$;
grant execute on function public.get_practice_questions(text,text,text,integer) to authenticated;

-- 15) Keep question counts separate from total possible marks when custom marks are used.
alter table public.results add column if not exists question_count integer not null default 0;
update public.results set question_count=total::integer where question_count=0;
-- Recreate the grading functions with question_count populated.
create or replace function public.submit_exam(p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.exam_attempts%rowtype; e public.exams%rowtype; total_n integer; score_n numeric(10,2):=0;
  correct_n integer:=0; subject_stats jsonb:='{}'::jsonb; answer_rows jsonb; item record; selected_n integer;
  result_row public.results%rowtype; now_at timestamptz:=clock_timestamp();
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into a from public.exam_attempts where id=p_attempt_id and user_id=auth.uid() for update;
  if not found or a.submitted_at is not null then raise exception 'এই পরীক্ষা ইতিমধ্যে জমা হয়েছে বা পাওয়া যায়নি'; end if;
  select * into e from public.exams where id=a.exam_id;
  select count(*) into total_n from public.exam_questions where exam_id=e.id;
  if total_n<1 then raise exception 'এই পরীক্ষায় কোনো প্রশ্ন নেই'; end if;
  for item in select q.id,q.answer,q.subject,aa.selected from public.exam_questions eq join public.questions q on q.id=eq.question_id
    left join public.exam_attempt_answers aa on aa.attempt_id=a.id and aa.question_id=q.id where eq.exam_id=e.id loop
    selected_n:=item.selected;
    if selected_n=item.answer then correct_n:=correct_n+1;score_n:=score_n+e.marks_per_question;
    elsif selected_n is not null then score_n:=score_n-e.negative_mark;end if;
    subject_stats:=jsonb_set(subject_stats,array[item.subject],coalesce(subject_stats->item.subject,'{"correct":0,"total":0,"score":0}'::jsonb)||
      jsonb_build_object('correct',coalesce((subject_stats->item.subject->>'correct')::int,0)+case when selected_n=item.answer then 1 else 0 end,
      'total',coalesce((subject_stats->item.subject->>'total')::int,0)+1,
      'score',coalesce((subject_stats->item.subject->>'score')::numeric,0)+case when selected_n=item.answer then e.marks_per_question when selected_n is not null then -e.negative_mark else 0 end),true);
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('question_id',eq.question_id,'selected',aa.selected) order by eq.sort_order),'[]'::jsonb)
  into answer_rows from public.exam_questions eq left join public.exam_attempt_answers aa on aa.attempt_id=a.id and aa.question_id=eq.question_id where eq.exam_id=e.id;
  insert into public.results(user_id,exam_id,title,score,total,question_count,by_subject,answers,attempt_id)
  values(auth.uid(),e.id,e.name,greatest(0,round(score_n,2)),total_n*e.marks_per_question,total_n,subject_stats,answer_rows,a.id)
  returning * into result_row;
  update public.exam_attempts set submitted_at=now_at,result_id=result_row.id where id=a.id;
  return jsonb_build_object('id',result_row.id,'title',result_row.title,'score',result_row.score,'total',result_row.total,
    'question_count',result_row.question_count,'by_subject',result_row.by_subject,'created_at',result_row.created_at,
    'percentage',round((result_row.score::numeric/nullif(result_row.total,0))*100,2));
end $$;
grant execute on function public.submit_exam(uuid) to authenticated;

create or replace function public.submit_practice(p_answers jsonb,p_title text default 'Practice')
returns jsonb language plpgsql security definer set search_path=public as $$
declare total_n integer; score_n integer:=0; by_sub jsonb:='{}'::jsonb; item record; sel integer; out_result jsonb; distinct_n integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_answers is null or jsonb_typeof(p_answers)<>'array' then raise exception 'Invalid answers'; end if;
  select count(*),count(distinct value->>'question_id') into total_n,distinct_n from jsonb_array_elements(p_answers);
  if total_n<1 or total_n<>distinct_n then raise exception 'প্রশ্নের তালিকা খালি বা duplicate'; end if;
  for item in select q.id,q.answer,q.subject,x.value->>'selected' selected from jsonb_array_elements(p_answers) x(value)
    join public.questions q on q.id=(x.value->>'question_id')::uuid
    where not exists(select 1 from public.exam_questions eq join public.exams e on e.id=eq.exam_id where eq.question_id=q.id and (e.end_at is null or clock_timestamp()<e.end_at)) loop
    sel:=nullif(item.selected,'')::integer;if sel is not null and (sel<0 or sel>3) then raise exception 'Invalid selected option';end if;
    if sel=item.answer then score_n:=score_n+1;end if;
    by_sub:=jsonb_set(by_sub,array[item.subject],coalesce(by_sub->item.subject,'{"correct":0,"total":0}'::jsonb)||
      jsonb_build_object('correct',coalesce((by_sub->item.subject->>'correct')::int,0)+case when sel=item.answer then 1 else 0 end,
      'total',coalesce((by_sub->item.subject->>'total')::int,0)+1),true);
  end loop;
  if (select count(*) from jsonb_array_elements(p_answers) x(value) join public.questions q on q.id=(x.value->>'question_id')::uuid
    where not exists(select 1 from public.exam_questions eq join public.exams e on e.id=eq.exam_id where eq.question_id=q.id and (e.end_at is null or clock_timestamp()<e.end_at)))<>total_n then
    raise exception 'Exam-এর প্রশ্ন Practice result-এ ব্যবহার করা যাবে না';end if;
  insert into public.results(user_id,title,score,total,question_count,by_subject,answers)
  values(auth.uid(),coalesce(nullif(p_title,''),'Practice'),score_n,total_n,total_n,by_sub,
    (select coalesce(jsonb_agg(jsonb_build_object('question_id',x.value->>'question_id','selected',nullif(x.value->>'selected','')::integer)),'[]'::jsonb) from jsonb_array_elements(p_answers) x(value)))
  returning jsonb_build_object('id',id,'title',title,'score',score,'total',total,'question_count',question_count,'by_subject',by_subject,'created_at',created_at) into out_result;
  return out_result;
end $$;
grant execute on function public.submit_practice(jsonb,text) to authenticated;

-- 16) Competitive ranking uses each student's best score per scheduled exam,
-- so repeating an exam cannot inflate total marks or rank.
create or replace function public.get_student_dashboard()
returns jsonb language plpgsql security definer set search_path=public as $$
declare me_id uuid:=auth.uid(); mine jsonb; board jsonb; old_rank bigint; new_rank bigint;
begin
  if me_id is null then raise exception 'Authentication required'; end if;
  select rank_no into old_rank from public.ranking_snapshots where user_id=me_id order by snapshot_at desc limit 1;
  with per_exam as (
    select user_id,exam_id,max(score) best_score,max(total) max_score
    from public.results where exam_id is not null group by user_id,exam_id
  ), totals as (
    select p.id,p.username,p.first_name,p.last_name,coalesce(sum(pe.best_score),0)::numeric total_score,
      count(pe.exam_id)::integer tests,coalesce(sum(pe.max_score),0)::numeric total_questions,
      coalesce(avg(case when pe.max_score>0 then pe.best_score/pe.max_score*100 end),0)::numeric avg_percent
    from public.profiles p left join per_exam pe on pe.user_id=p.id where p.role='student' group by p.id
  ), ranked as (select *,rank() over(order by total_score desc) rank_no,count(*) over() student_count from totals)
  select to_jsonb(x),x.rank_no into mine,new_rank from ranked x where id=me_id;
  if mine is null then raise exception 'Student profile পাওয়া যায়নি'; end if;
  mine:=mine||jsonb_build_object('rank_change',case when old_rank is null then 0 else old_rank-new_rank end,'previous_rank',old_rank);
  with per_exam as (
    select user_id,exam_id,max(score) best_score,max(total) max_score
    from public.results where exam_id is not null group by user_id,exam_id
  ), totals as (
    select p.id,p.username,p.first_name,p.last_name,coalesce(sum(pe.best_score),0)::numeric total_score,
      count(pe.exam_id)::integer tests,coalesce(avg(case when pe.max_score>0 then pe.best_score/pe.max_score*100 end),0)::numeric avg_percent
    from public.profiles p left join per_exam pe on pe.user_id=p.id where p.role='student' group by p.id
  ), ranked as (select *,rank() over(order by total_score desc) rank_no from totals)
  select coalesce(jsonb_agg(to_jsonb(x) order by rank_no,total_score desc),'[]'::jsonb) into board
  from (select * from ranked order by rank_no,total_score desc limit 100) x;
  insert into public.ranking_snapshots(user_id,rank_no)
  with per_exam as (select user_id,exam_id,max(score) best_score from public.results where exam_id is not null group by user_id,exam_id), totals as (
    select p.id,coalesce(sum(pe.best_score),0)::numeric total_score from public.profiles p left join per_exam pe on pe.user_id=p.id
    where p.role='student' group by p.id)
  select id,rank() over(order by total_score desc) from totals;
  return jsonb_build_object('me',mine,'leaderboard',board);
end $$;
grant execute on function public.get_student_dashboard() to authenticated;

create or replace function public.admin_student_progress(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.profiles%rowtype; summary jsonb; history jsonb; subjects jsonb;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select * into u from public.profiles where id=p_user_id and role='student';
  if not found then raise exception 'Student পাওয়া যায়নি'; end if;
  with best as (
    select exam_id,max(score) score,max(total) total,max(created_at) last_attempt
    from public.results where user_id=p_user_id and exam_id is not null group by exam_id
  )
  select jsonb_build_object('tests',count(*),'score',coalesce(sum(score),0),'total',coalesce(sum(total),0),
    'average_percent',coalesce(avg(score::numeric/nullif(total,0)*100),0),'last_exam',max(last_attempt)) into summary from best;
  select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc),'[]'::jsonb) into history
  from (select id,title,score,total,by_subject,created_at from public.results where user_id=p_user_id order by created_at desc limit 100) x;
  with best_result as (
    select distinct on (exam_id) by_subject from public.results
    where user_id=p_user_id and exam_id is not null order by exam_id,score desc,created_at desc
  )
  select coalesce(jsonb_object_agg(subject,json),'{}'::jsonb) into subjects from (
    select key subject,jsonb_build_object('correct',sum((value->>'correct')::numeric),'total',sum((value->>'total')::numeric)) json
    from best_result b cross join lateral jsonb_each(b.by_subject) group by key
  ) s;
  return jsonb_build_object('student',to_jsonb(u),'summary',summary,'history',history,'subjects',subjects);
end $$;
grant execute on function public.admin_student_progress(uuid) to authenticated;

-- 17) Preserve the student's history-cleanup utility without allowing deletion of official exam results.
create or replace function public.clear_practice_history()
returns integer language plpgsql security definer set search_path=public as $$
declare removed integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  delete from public.results where user_id=auth.uid() and exam_id is null;
  get diagnostics removed = row_count;
  return removed;
end $$;
grant execute on function public.clear_practice_history() to authenticated;
