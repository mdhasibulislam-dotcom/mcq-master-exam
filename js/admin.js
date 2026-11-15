/* MCQ Master — Admin panel: progress, bulk delete and advanced exam builder */
let me = null, questions = [], exams = [], examCounts = {}, users = [], editing = null;
const L = 'ABCD';
const selectedQuestionIds = new Set();
const examSelectedQuestionIds = new Set();
const $id = id => document.getElementById(id);
const localInputValue = value => { if(!value) return ''; const d=new Date(new Date(value).getTime()-new Date(value).getTimezoneOffset()*60000); return d.toISOString().slice(0,16); };

async function boot() {
  try {
    me = await requireAuth('admin'); if (!me) return;
    $id('adminName').textContent = `${me.first_name} · Admin`;
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}
async function loadAll() {
  const [q,e,eq,u] = await Promise.all([
    fetchAll(() => supabase.from('questions').select('*').order('created_at',{ascending:false}).order('id')),
    supabase.from('exams').select('*').order('created_at',{ascending:false}),
    fetchAll(() => supabase.from('exam_questions').select('exam_id,question_id').order('exam_id').order('question_id')),
    fetchAll(() => supabase.from('profiles').select('id,username,first_name,last_name,email,phone,role,created_at').order('created_at',{ascending:false}).order('id'))
  ]);
  if(e.error) throw e.error; questions=q; exams=e.data||[]; users=u;
  examCounts={}; eq.forEach(r=>examCounts[r.exam_id]=(examCounts[r.exam_id]||0)+1);
  [...selectedQuestionIds].forEach(id=>{if(!questions.some(q=>q.id===id)) selectedQuestionIds.delete(id);});
  [...examSelectedQuestionIds].forEach(id=>{if(!questions.some(q=>q.id===id)) examSelectedQuestionIds.delete(id);});
  render();
}
function fillSubjects(id, first) {
  const el=$id(id); if(!el) return [];
  const cur=el.value, subs=[...new Set(questions.map(q=>q.subject))].sort();
  el.innerHTML=`<option value="">${first}</option>`+subs.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
  el.value=subs.includes(cur)?cur:''; return subs;
}
function render() {
  $id('statQ').textContent=questions.length; $id('statS').textContent=new Set(questions.map(q=>q.subject)).size;
  $id('statE').textContent=exams.length; $id('statU').textContent=users.filter(u=>u.role==='student').length;
  const cnt={}; questions.forEach(q=>cnt[q.subject]=(cnt[q.subject]||0)+1); const max=Math.max(1,...Object.values(cnt));
  $id('subjectBars').innerHTML=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).map(([s,n])=>`<div class="bar-row"><span>${esc(s)}</span><div class="bar"><i style="width:${n/max*100}%"></i></div><b>${n}</b></div>`).join('')||'<p class="empty">এখনো কোনো প্রশ্ন নেই।</p>';
  $id('recent').innerHTML=questions.slice(0,6).map(q=>`<div class="mini"><span>${esc(q.text)}</span><em class="pill">${esc(q.subject)}</em></div>`).join('')||'<p class="empty">প্রথম প্রশ্ন যোগ করো।</p>';
  const subs=fillSubjects('filterSubject','All subjects'); fillSubjects('examSubject','Mixed subjects');
  $id('subjectHints').innerHTML=subs.map(s=>`<option value="${esc(s)}">`).join('');
  renderQuestions(); renderExams(); renderExamPicker(); renderUsers(); updateBulkTools();
}
function renderQuestions() {
  const s=$id('filterSubject').value, term=$id('searchQ').value.toLowerCase();
  const rows=questions.filter(q=>(!s||q.subject===s)&&(!term||`${q.text} ${q.subject} ${q.chapter||''} ${q.tag||''}`.toLowerCase().includes(term)));
  $id('questionList').innerHTML=rows.length?rows.map(q=>`<article class="q">
    <header><label class="question-select"><input type="checkbox" data-select-question="${q.id}" ${selectedQuestionIds.has(q.id)?'checked':''}><span>Select</span></label><span class="pill d-${esc(q.difficulty)}">${esc(q.difficulty)}</span><span class="pill">${esc(q.subject)}</span>${q.chapter?`<span class="pill">${esc(q.chapter)}</span>`:''}${q.tag?`<span class="pill">${esc(q.tag)}</span>`:''}
    <div class="q-actions"><button class="btn btn-sm" data-edit="${q.id}">Edit</button><button class="btn btn-sm danger" data-delete="${q.id}">Delete</button></div></header>
    <h3>${esc(q.text)}</h3><ol class="opts">${[q.option_a,q.option_b,q.option_c,q.option_d].map((o,i)=>`<li class="${i===q.answer?'ok':''}"><b>${L[i]}</b><span>${esc(o)}</span></li>`).join('')}</ol>
    ${q.explanation?`<p class="note">${esc(q.explanation)}</p>`:''}</article>`).join(''):'<div class="card empty">কোনো প্রশ্ন মেলেনি।</div>';
}
function updateBulkTools(){
  const count=selectedQuestionIds.size; $id('selectedQuestionCount').textContent=`${count}টি নির্বাচিত`;
  $id('bulkDeleteBtn').disabled=!count; const visible=[...document.querySelectorAll('[data-select-question]')];
  $id('selectAllQuestions').checked=visible.length>0&&visible.every(x=>x.checked);
}
function renderExamPicker(){
  const s=$id('examSubject').value, ch=$id('examChapter').value.trim().toLowerCase();
  const pool=questions.filter(q=>(!s||q.subject===s)&&(!ch||(q.chapter||'').toLowerCase().includes(ch)));
  $id('examQuestionPicker').innerHTML=pool.length?pool.map(q=>`<label class="exam-pick"><input type="checkbox" data-exam-question="${q.id}" ${examSelectedQuestionIds.has(q.id)?'checked':''}><span><b>${esc(q.subject)}${q.chapter?' · '+esc(q.chapter):''}</b><small>${esc(q.text)}</small></span></label>`).join(''):'<p class="empty">এই ফিল্টারে প্রশ্ন নেই। নতুন প্রশ্ন তৈরি করতে পারো।</p>';
  $id('builderSelectedCount').textContent=`${examSelectedQuestionIds.size}টি প্রশ্ন নির্বাচিত`;
}
function renderExams(){
  $id('examList').innerHTML=exams.length?exams.map(e=>`<div class="row-item exam-row"><div><b>${esc(e.name)}</b><p class="sub">${e.minutes} min · ${examCounts[e.id]||0} questions · ${esc(e.subject||'Mixed')}</p><p class="sub">${e.start_at?'Start: '+new Date(e.start_at).toLocaleString():'Start: এখনই'} · ${e.end_at?'End: '+new Date(e.end_at).toLocaleString():'End: নির্ধারিত নয়'}</p></div><div class="acts"><span class="pill ${e.is_published?'live':'draft'}">${e.is_published?'Published':'Hidden'}</span><button class="btn btn-sm" data-toggle="${e.id}">${e.is_published?'Unpublish':'Publish'}</button><button class="btn btn-sm" data-print-exam="${e.id}">Print paper</button><button class="btn btn-sm danger" data-exdelete="${e.id}">Delete</button></div><details class="schedule-edit"><summary>Schedule/Edit settings</summary><div class="fg"><label>Start<input type="datetime-local" id="start-${e.id}" value="${localInputValue(e.start_at)}"></label><label>End<input type="datetime-local" id="end-${e.id}" value="${localInputValue(e.end_at)}"></label><label>Duration (min)<input type="number" min="1" id="duration-${e.id}" value="${e.minutes}"></label></div><button class="btn btn-sm" data-save-schedule="${e.id}">Save schedule</button></details></div>`).join(''):'<p class="empty">এখনো কোনো পরীক্ষা নেই।</p>';
}
function renderUsers(){
  const students=users.filter(u=>u.role==='student');
  $id('userList').innerHTML=students.map(u=>`<div class="user"><div class="av">${esc((u.first_name||u.username||'?')[0].toUpperCase())}</div><div><b>${esc((u.first_name+' '+u.last_name).trim())}</b><small>@${esc(u.username)} · ${esc(u.email)}${u.phone?' · '+esc(u.phone):''}</small><small>Joined ${new Date(u.created_at).toLocaleDateString()}</small></div><button class="btn btn-sm" data-progress="${u.id}">Progress</button></div>`).join('')||'<p class="empty">No students yet.</p>';
}
async function showStudentProgress(id){
  const box=$id('studentProgressDetail'); box.innerHTML='<p class="empty">Progress load হচ্ছে…</p>';
  const {data,error}=await supabase.rpc('admin_student_progress',{p_user_id:id});
  if(error){box.innerHTML=`<p class="tag-bad">${esc(error.message)}</p>`;return;}
  const s=data.summary||{}, u=data.student||{}, subjects=data.subjects||{};
  box.innerHTML=`<div class="sec-head"><div><h3>${esc(u.first_name||'Student')} ${esc(u.last_name||'')} · @${esc(u.username||'')}</h3><p class="sub">Student Progress Report</p></div><button class="btn btn-sm" id="printStudentProgress">Print report</button></div>
    <div class="stats"><div class="stat"><small>Total exams</small><b>${s.tests||0}</b></div><div class="stat"><small>Total marks</small><b>${s.score||0}/${s.total||0}</b></div><div class="stat"><small>Average</small><b>${Number(s.average_percent||0).toFixed(1)}%</b></div><div class="stat"><small>Last exam</small><b>${s.last_exam?new Date(s.last_exam).toLocaleDateString():'—'}</b></div></div>
    <h4>Subject-wise performance</h4>${Object.entries(subjects).map(([sub,v])=>{const rate=v.total?Math.round(v.correct/v.total*100):0;const label=rate>=70?'ভালো':rate<50?'দুর্বল':'মাঝারি';return `<div class="bar-row"><span>${esc(sub)}</span><div class="bar"><i style="width:${rate}%"></i></div><b>${v.correct||0}/${v.total||0}</b><small>${label} · ${rate}%</small></div>`;}).join('')||'<p class="empty">এখনো subject data নেই।</p>'}
    <h4>Result history</h4>${(data.history||[]).map(r=>`<div class="row-item"><div><b>${esc(r.title)}</b><p class="sub">${new Date(r.created_at).toLocaleString()}</p></div><b>${r.score}/${r.total} (${Math.round(r.score/r.total*100)}%)</b></div>`).join('')||'<p class="empty">কোনো পরীক্ষা দেয়নি।</p>'}`;
  $id('printStudentProgress').onclick=()=>{document.body.classList.add('printing-progress');window.print();document.body.classList.remove('printing-progress');};
}
function openQuestion(q){editing=q?q.id:null;$id('modalTitle').textContent=q?'Edit question':'Add question';$id('qText').value=q?.text||'';['A','B','C','D'].forEach(x=>$id('opt'+x).value=q?.['option_'+x.toLowerCase()]||'');$id('qAnswer').value=q?.answer??0;$id('qSubject').value=q?.subject||'';$id('qChapter').value=q?.chapter||'';$id('qDifficulty').value=q?.difficulty||'Medium';$id('qTag').value=q?.tag||'';$id('qExplanation').value=q?.explanation||'';$id('questionModal').classList.remove('hidden');}
const closeModal=()=> $id('questionModal').classList.add('hidden');
$id('questionForm').onsubmit=async e=>{e.preventDefault();const payload={text:$id('qText').value.trim(),option_a:$id('optA').value.trim(),option_b:$id('optB').value.trim(),option_c:$id('optC').value.trim(),option_d:$id('optD').value.trim(),answer:+$id('qAnswer').value,subject:$id('qSubject').value.trim(),chapter:$id('qChapter').value.trim(),difficulty:$id('qDifficulty').value,tag:$id('qTag').value.trim(),explanation:$id('qExplanation').value.trim()};try{const r=editing?await supabase.from('questions').update(payload).eq('id',editing):await supabase.from('questions').insert({...payload,created_by:me.id});if(r.error)throw r.error;closeModal();toast(editing?'Question updated':'Question added');await loadAll();}catch(err){toast(err.message,'error');}};

$id('addBuilderQuestion').onclick=async()=>{
  const payload={text:$id('builderQText').value.trim(),option_a:$id('builderA').value.trim(),option_b:$id('builderB').value.trim(),option_c:$id('builderC').value.trim(),option_d:$id('builderD').value.trim(),answer:+$id('builderAnswer').value,subject:$id('builderSubject').value.trim()||$id('examSubject').value,chapter:$id('builderChapter').value.trim(),difficulty:'Medium',explanation:$id('builderExplanation').value.trim(),created_by:me.id};
  if(!payload.text||!payload.option_a||!payload.option_b||!payload.option_c||!payload.option_d||!payload.subject)return toast('প্রশ্ন, চারটি অপশন ও Subject পূরণ করো।','error');
  const duplicate=questions.find(q=>q.subject.toLowerCase()===payload.subject.toLowerCase()&&q.text.trim().toLowerCase()===payload.text.toLowerCase());
  if(duplicate){examSelectedQuestionIds.add(duplicate.id);toast('একই প্রশ্ন আগে থেকেই আছে; সেটি Exam-এ select করা হয়েছে।');renderExamPicker();return;}
  const {data,error}=await supabase.from('questions').insert(payload).select('id').single();if(error)return toast(error.message,'error');
  examSelectedQuestionIds.add(data.id);['builderQText','builderA','builderB','builderC','builderD','builderChapter','builderExplanation'].forEach(id=>$id(id).value='');toast('Question Bank-এ save হয়েছে এবং Exam-এ select হয়েছে।');await loadAll();
};
$id('createExam').onclick=async()=>{
  const name=$id('examName').value.trim(),minutes=+$id('examMinutes').value,ids=[...examSelectedQuestionIds];
  const start=$id('examStartAt').value?new Date($id('examStartAt').value).toISOString():null,end=$id('examEndAt').value?new Date($id('examEndAt').value).toISOString():null;
  if(!name||minutes<1||!ids.length)return toast('Exam name, duration ও অন্তত একটি প্রশ্ন নির্বাচন করো।','error');
  if($id('publishExam').checked&&(!start||!end))return toast('Publish করার আগে Start ও End date/time নির্ধারণ করো।','error');if(start&&end&&new Date(end)<=new Date(start))return toast('End time অবশ্যই Start time-এর পরে হতে হবে।','error');
  const payload={name,subject:$id('examSubject').value,minutes,start_at:start,end_at:end,marks_per_question:+$id('marksPerQuestion').value||1,negative_mark:+$id('negativeMark').value||0,randomize_questions:$id('randomizeQuestions').checked,is_published:$id('publishExam').checked,allow_review:true};
  const {data,error}=await supabase.rpc('admin_create_exam',{p_exam:payload,p_question_ids:ids});
  if(error)return toast(error.message,'error');
  examSelectedQuestionIds.clear();$id('examName').value='';$id('examStartAt').value='';$id('examEndAt').value='';toast('Exam তৈরি হয়েছে।');await loadAll();
};

$id('questionList').onclick=async e=>{const b=e.target.closest('button');if(!b)return;const edit=b.dataset.edit,del=b.dataset.delete;if(edit)openQuestion(questions.find(q=>q.id===edit));if(del){if(!confirm('এই প্রশ্নটি স্থায়ীভাবে Delete করবে? সংশ্লিষ্ট exam থেকে সরে যাবে।'))return;const {error}=await supabase.from('questions').delete().eq('id',del);if(error)toast(error.message,'error');else{selectedQuestionIds.delete(del);toast('Question deleted');await loadAll();}}};
$id('questionList').onchange=e=>{const id=e.target.dataset.selectQuestion;if(!id)return;e.target.checked?selectedQuestionIds.add(id):selectedQuestionIds.delete(id);updateBulkTools();renderExamPicker();};
$id('selectAllQuestions').onchange=e=>{document.querySelectorAll('[data-select-question]').forEach(x=>{x.checked=e.target.checked;e.target.checked?selectedQuestionIds.add(x.dataset.selectQuestion):selectedQuestionIds.delete(x.dataset.selectQuestion);});updateBulkTools();renderExamPicker();};
$id('clearQuestionSelection').onclick=()=>{selectedQuestionIds.clear();renderQuestions();renderExamPicker();updateBulkTools();};
$id('bulkDeleteBtn').onclick=()=>{$id('deleteConfirmText').textContent=`${selectedQuestionIds.size}টি প্রশ্ন স্থায়ীভাবে Delete হবে। এই প্রশ্নগুলো যুক্ত থাকা Exam থেকেও বাদ যাবে।`; $id('deleteConfirmModal').classList.remove('hidden');};
const closeDelete=()=> $id('deleteConfirmModal').classList.add('hidden');
$id('closeDeleteConfirm').onclick=$id('cancelBulkDelete').onclick=closeDelete;
$id('confirmBulkDelete').onclick=async()=>{const ids=[...selectedQuestionIds];if(!ids.length)return closeDelete();const b=$id('confirmBulkDelete');b.disabled=true;b.textContent='Deleting…';try{const {error}=await supabase.from('questions').delete().in('id',ids);if(error)throw error;selectedQuestionIds.clear();closeDelete();toast(`${ids.length}টি প্রশ্ন Delete হয়েছে।`);await loadAll();}catch(e){toast(e.message,'error');}finally{b.disabled=false;b.textContent='Confirm Delete';}};
$id('examQuestionPicker').onchange=e=>{const id=e.target.dataset.examQuestion;if(!id)return;e.target.checked?examSelectedQuestionIds.add(id):examSelectedQuestionIds.delete(id);$id('builderSelectedCount').textContent=`${examSelectedQuestionIds.size}টি প্রশ্ন নির্বাচিত`;};
$id('examSelectAll').onchange=e=>{document.querySelectorAll('[data-exam-question]').forEach(x=>{x.checked=e.target.checked;e.target.checked?examSelectedQuestionIds.add(x.dataset.examQuestion):examSelectedQuestionIds.delete(x.dataset.examQuestion);});$id('builderSelectedCount').textContent=`${examSelectedQuestionIds.size}টি প্রশ্ন নির্বাচিত`;};
$id('examSubject').onchange=renderExamPicker;$id('examChapter').oninput=renderExamPicker;
$id('examList').onclick=async e=>{const b=e.target.closest('button');if(!b)return;const id=b.dataset.toggle,del=b.dataset.exdelete,sid=b.dataset.saveSchedule,pid=b.dataset.printExam;if(id){const ex=exams.find(x=>x.id===id);const {error}=await supabase.from('exams').update({is_published:!ex.is_published}).eq('id',id);if(error)toast(error.message,'error');else{toast('Exam status updated');await loadAll();}}if(del&&confirm('এই Exam মুছবে?')){const {error}=await supabase.from('exams').delete().eq('id',del);if(error)toast(error.message,'error');else{toast('Exam deleted');await loadAll();}}if(pid){const {data:rows,error}=await supabase.from('exam_questions').select('sort_order,questions(*)').eq('exam_id',pid).order('sort_order');if(error)return toast(error.message,'error');const ex=exams.find(x=>x.id===pid);const area=document.createElement('section');area.id='printArea';area.innerHTML=`<h1>${esc(ex?.name||'Question Paper')}</h1><p>${esc(ex?.subject||'Mixed')} · ${ex?.minutes||''} minutes</p>${(rows||[]).map((r,i)=>`<article><h3>${i+1}. ${esc(r.questions.text)}</h3><ol type="A">${[r.questions.option_a,r.questions.option_b,r.questions.option_c,r.questions.option_d].map(o=>`<li>${esc(o)}</li>`).join('')}</ol></article>`).join('')}`;document.body.append(area);document.body.classList.add('printing-paper');window.print();document.body.classList.remove('printing-paper');area.remove();}if(sid){const st=$id('start-'+sid).value,en=$id('end-'+sid).value,dur=+$id('duration-'+sid).value;const payload={start_at:st?new Date(st).toISOString():null,end_at:en?new Date(en).toISOString():null,minutes:dur};const {error}=await supabase.from('exams').update(payload).eq('id',sid);if(error)toast(error.message,'error');else{toast('Schedule updated');await loadAll();}}};
$id('userList').onclick=e=>{const b=e.target.closest('[data-progress]');if(b)showStudentProgress(b.dataset.progress);};
const show=v=>{$$('.nav button').forEach(x=>x.classList.toggle('active',x.dataset.view===v));$$('.view').forEach(x=>x.classList.toggle('hidden',x.id!==v));};
$$('.nav button').forEach(b=>b.onclick=()=>show(b.dataset.view));$$('[data-jump]').forEach(b=>b.onclick=()=>show(b.dataset.jump));
$id('searchQ').oninput=renderQuestions;$id('filterSubject').onchange=renderQuestions;$id('newQuestion').onclick=()=>openQuestion();$id('closeModal').onclick=$id('cancelModal').onclick=closeModal;
boot();
