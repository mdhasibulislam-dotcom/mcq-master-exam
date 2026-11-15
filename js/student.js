/* MCQ Master — Student panel. Exam answers are saved and graded by Supabase RPCs. */
let me=null,questions=[],qmap=new Map(),exams=[],results=[],bookmarks=new Set(),quiz=null,timerId=null;
const L='ABCD', opts=q=>[q.option_a,q.option_b,q.option_c,q.option_d], pct=(s,t)=>t?Math.round(s/t*100):0;
const $id=id=>document.getElementById(id);
async function boot(){try{me=await requireAuth('student');if(!me)return;$id('welcome').textContent=`স্বাগতম, ${me.first_name}`;await loadData();}catch(e){toast(e.message,'error');}}
async function loadData(){
 const [qs,ex,rs,bm,rank]=await Promise.all([
  supabase.rpc('get_practice_questions',{p_subject:null,p_chapter:null,p_difficulty:null,p_limit:500}),
  supabase.rpc('get_student_exams'),
  fetchAll(()=>supabase.from('results').select('id,exam_id,title,score,total,question_count,by_subject,created_at').order('created_at',{ascending:false}).order('id')),
  supabase.from('bookmarks').select('question_id'),
  supabase.rpc('get_student_dashboard')
 ]);
 for(const x of [qs,ex,bm,rank])if(x.error)throw x.error;
 questions=qs.data||[];qmap=new Map(questions.map(q=>[q.id,q]));exams=ex.data||[];results=rs;bookmarks=new Set((bm.data||[]).map(x=>x.question_id));render(rank.data);
}
const resRow=(r,i)=>`<div class="row-item"><div><b>${esc(r.title)}</b><p class="sub">${new Date(r.created_at).toLocaleString()}</p></div><div class="acts"><span class="pill ${pct(r.score,r.total)>=60?'live':'draft'}">${r.score}/${r.total} · ${pct(r.score,r.total)}%</span><button class="btn btn-sm" data-review="${r.id}">Review</button></div></div>`;
function render(rank){
 const subs=[...new Set(questions.map(q=>q.subject))].sort();['quickSubject','practiceSubject'].forEach(id=>{const el=$id(id),cur=el.value;el.innerHTML='<option value="">All subjects</option>'+subs.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');el.value=subs.includes(cur)?cur:'';});
 const total=results.reduce((a,r)=>a+(r.question_count||r.total),0),correct=results.reduce((a,r)=>a+Object.values(r.by_subject||{}).reduce((n,v)=>n+(v.correct||0),0),0);
 $id('totalTests').textContent=results.length;$id('totalQs').textContent=total;$id('totalCorrect').textContent=correct;$id('accuracy').textContent=pct(correct,total)+'%';
 $id('recentResults').innerHTML=results.slice(0,5).map(resRow).join('')||'<p class="empty">এখনো কোনো পরীক্ষা দাওনি।</p>';
 $id('historyList').innerHTML=results.map(resRow).join('')||'<p class="empty">কোনো result নেই।</p>';
 $id('examList').innerHTML=exams.length?exams.map(e=>{const a=examAvail(e);return `<div class="row-item"><div><b>${esc(e.name)}</b><p class="sub">${e.minutes} মিনিট · ${e.question_count} প্রশ্ন · ${esc(e.subject||'Mixed subjects')}</p><p class="sub">${a.text}</p></div><button class="btn btn-primary btn-sm" data-exam="${e.id}" ${a.ended?'disabled':''}>${a.ended?'Ended':'Participate'}</button></div>`;}).join(''):'<p class="empty">এখনো কোনো প্রকাশিত পরীক্ষা নেই।</p>';
 renderSaved();renderRanking(rank);
}
function renderRanking(data){const m=data?.me||{};$id('myRankSummary').innerHTML=`<div class="rank-stats"><div><small>তোমার Rank</small><b>#${m.rank_no||'—'}</b><small>${m.previous_rank==null?'নতুন ranking':m.rank_change>0?`আগেরবারের চেয়ে ${m.rank_change} ধাপ এগিয়েছ`:m.rank_change<0?`${Math.abs(m.rank_change)} ধাপ পিছিয়েছ`:'Rank অপরিবর্তিত'}</small></div><div><small>মোট শিক্ষার্থী</small><b>${m.student_count||0}</b></div><div><small>মোট নম্বর</small><b>${m.total_score||0}</b></div><div><small>Average</small><b>${Number(m.avg_percent||0).toFixed(1)}%</b></div><div><small>পরীক্ষা</small><b>${m.tests||0}</b></div></div>`;
 const board=data?.leaderboard||[];$id('leaderboard').innerHTML=board.length?`<h4>Leaderboard · Top 100</h4>${board.map(x=>`<div class="rank-row ${x.id===me.id?'my-rank':''}"><b>#${x.rank_no}</b><span>${esc((x.first_name||'Student')+' '+(x.last_name||''))}</span><small>${x.tests} tests</small><strong>${x.total_score}</strong></div>`).join('')}`:'<p class="empty">Ranking দেখানোর মতো data নেই।</p>'; 
}
function renderSaved(){const qs=questions.filter(q=>bookmarks.has(q.id));$id('savedList').innerHTML=qs.length?qs.map(q=>`<article class="q"><header><span class="pill">${esc(q.subject)}</span><span class="pill">${esc(q.chapter||'')}</span><div class="q-actions"><button class="btn btn-sm danger" data-unsave="${q.id}">Remove</button></div></header><h3>${esc(q.text)}</h3><ol class="opts">${opts(q).map((o,i)=>`<li class="${i===q.answer?'ok':''}"><b>${L[i]}</b><span>${esc(o)}</span></li>`).join('')}</ol>${q.explanation?`<p class="note">${esc(q.explanation)}</p>`:''}</article>`).join(''):'<div class="card empty">কোনো প্রশ্ন Save করা নেই।</div>';}
const fmtDate=d=>d?new Date(d).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}):'—';
function examAvail(e){const now=Date.now(),start=e.start_at?new Date(e.start_at).getTime():0,end=e.end_at?new Date(e.end_at).getTime():Infinity;
 if(now<start)return {open:false,ended:false,text:'শুরু হবে '+fmtDate(e.start_at)};
 if(now>=end)return {open:false,ended:true,text:'সময় শেষ'};
 return {open:true,ended:false,text:'পরীক্ষা চলমান'};}
let infoExam=null;
function openExamInfo(id){const e=exams.find(x=>x.id===id);if(!e)return;infoExam=e;const a=examAvail(e);
 $id('eiName').textContent=e.name;$id('eiState').textContent=a.text;
 const tiles=[['সময়',e.minutes+' মিনিট'],['মোট প্রশ্ন',e.question_count+' টি'],['প্রতি প্রশ্নে নম্বর',e.marks_per_question??1],['Negative mark',Number(e.negative_mark||0)>0?'−'+e.negative_mark:'নেই'],['বিষয়',e.subject||'Mixed subjects'],['শুরু',e.start_at?fmtDate(e.start_at):'যেকোনো সময়'],['শেষ',e.end_at?fmtDate(e.end_at):'নির্দিষ্ট নেই']];
 $id('eiGrid').innerHTML=tiles.map(([k,v])=>`<div><small>${k}</small><b>${esc(String(v))}</b></div>`).join('');
 const st=$id('eiStart');st.disabled=!a.open||!e.question_count;st.textContent=a.open?'Start exam':(a.ended?'সময় শেষ':'এখনো শুরু হয়নি');
 $id('examInfoModal').classList.remove('hidden');}
const closeExamInfo=()=>{$id('examInfoModal').classList.add('hidden');infoExam=null;};
$id('eiClose').onclick=$id('eiCancel').onclick=closeExamInfo;
$id('examInfoModal').addEventListener('click',e=>{if(e.target.id==='examInfoModal')closeExamInfo();});
$id('eiStart').onclick=async()=>{if(!infoExam)return;const b=$id('eiStart'),id=infoExam.id;b.disabled=true;
 try{await startScheduledExam(id);closeExamInfo();}catch(err){toast(err.message,'error');b.disabled=false;}};
function startPractice(title,qs){if(!qs.length)return toast('এই selection-এ কোনো প্রশ্ন নেই।','error');clearInterval(timerId);quiz={mode:'practice',title,qs,i:0,ans:Array(qs.length).fill(null),locked:Array(qs.length).fill(false),sel:null,done:false};$id('quizTitle').textContent=title;$id('timer').textContent='Practice';$id('quizModal').classList.remove('hidden');showQuestion();}
async function startScheduledExam(examId){
 const {data:attempt,error}=await supabase.rpc('start_exam',{p_exam_id:examId});if(error)throw error;
 const {data:qs,error:qerr}=await supabase.rpc('get_attempt_questions',{p_attempt_id:attempt.attempt_id});if(qerr)throw qerr;
 if(!qs?.length)throw new Error('এই পরীক্ষায় কোনো প্রশ্ন নেই।');clearInterval(timerId);
 quiz={mode:'exam',title:attempt.name,qs,i:0,ans:Array(qs.length).fill(null),locked:Array(qs.length).fill(false),sel:null,attemptId:attempt.attempt_id,
  endEpoch:Date.now()+(new Date(attempt.ends_at).getTime()-new Date(attempt.server_now).getTime()),done:false,saveQueue:Promise.resolve()};
 $id('quizTitle').textContent=attempt.name;$id('quizModal').classList.remove('hidden');tick();timerId=setInterval(()=>{if(!quiz)return;tick();},500);showQuestion();
}
function tick(){if(!quiz||quiz.mode!=='exam')return;const left=Math.max(0,Math.ceil((quiz.endEpoch-Date.now())/1000));$id('timer').textContent=`${String(Math.floor(left/60)).padStart(2,'0')}:${String(left%60).padStart(2,'0')}`;if(left<=0)finishQuiz(true);}
/* One question at a time. Exam: choose an answer, press Submit answer, the next question appears (no Next / Skip / Previous, no number grid). */
function showQuestion(){if(!quiz)return;const practice=quiz.mode==='practice',q=quiz.qs[quiz.i],locked=quiz.locked[quiz.i],chosen=practice?quiz.ans[quiz.i]:quiz.sel,last=quiz.i===quiz.qs.length-1;
 $id('progressBar').style.width=((quiz.i+1)/quiz.qs.length*100)+'%';
 const cls=i=>practice&&locked?(i===q.answer?'correct':i===chosen?'wrong':''):(chosen===i?'selected':'');
 $id('quizContent').innerHTML=`<div class="q-meta"><span class="pill">প্রশ্ন ${quiz.i+1}/${quiz.qs.length}</span><span class="pill">${esc(q.subject||'')}</span><span class="pill">${esc(q.chapter||'')}</span></div><h2 class="q-text">${esc(q.text)}</h2><div class="choices">${opts(q).map((o,i)=>`<button class="choice ${cls(i)}" data-answer="${i}" ${(practice&&locked)||quiz.saving?'disabled':''}><b>${L[i]}</b><span>${esc(o)}</span></button>`).join('')}</div>${practice&&locked?`<div class="feedback ${chosen===q.answer?'good':'bad'}"><b>${chosen===q.answer?'সঠিক উত্তর ✓':'সঠিক উত্তর: '+L[q.answer]}</b>${q.explanation?`<p>${esc(q.explanation)}</p>`:''}</div>`:''}${practice?'':'<p class="q-hint">উত্তর Submit করার পর আর বদলানো যাবে না।</p>'}<button class="btn btn-sm" id="bookmarkCurrent">${bookmarks.has(q.id)?'★ Saved':'☆ Save question'}</button>`;
 const btn=$id('nextQuestion');
 if(practice){btn.textContent=last?'Finish practice':'পরের প্রশ্ন →';btn.disabled=!locked;}
 else{btn.textContent=quiz.saving?'Saving…':(last?'Submit & finish':'Submit answer');btn.disabled=quiz.sel===null||!!quiz.saving;}
}
$id('quizContent').onclick=async e=>{if(!quiz)return;const b=e.target.closest('button');if(!b)return;
 if(b.dataset.answer!==undefined){if(quiz.saving)return;const sel=+b.dataset.answer;
  if(quiz.mode==='practice'){if(quiz.locked[quiz.i])return;quiz.ans[quiz.i]=sel;quiz.locked[quiz.i]=true;}else quiz.sel=sel;
  showQuestion();
 }else if(b.id==='bookmarkCurrent'){const id=quiz.qs[quiz.i].id;const r=bookmarks.has(id)?await supabase.from('bookmarks').delete().eq('user_id',me.id).eq('question_id',id):await supabase.from('bookmarks').insert({user_id:me.id,question_id:id});if(r.error)return toast(r.error.message,'error');bookmarks.has(id)?bookmarks.delete(id):bookmarks.add(id);showQuestion();}
};
$id('nextQuestion').onclick=async()=>{if(!quiz||quiz.saving)return;const qz=quiz,last=qz.i===qz.qs.length-1;
 if(qz.mode==='practice'){if(!qz.locked[qz.i])return;if(last)return finishQuiz(false);qz.i++;showQuestion();return;}
 if(qz.sel===null)return;const q=qz.qs[qz.i],selected=qz.sel;qz.saving=true;showQuestion();
 const pending=(async()=>{const {error}=await supabase.rpc('save_exam_answer',{p_attempt_id:qz.attemptId,p_question_id:q.id,p_selected:selected});if(error)throw error;})();qz.saveQueue=pending;
 try{await pending;}catch(err){qz.saveQueue=Promise.resolve();if(quiz===qz){qz.saving=false;toast('উত্তর Server-এ Save হয়নি: '+err.message,'error');showQuestion();}return;}
 if(quiz!==qz)return;qz.ans[qz.i]=selected;qz.sel=null;qz.saving=false;
 if(last)return finishQuiz(false);qz.i++;showQuestion();
};
$id('exitQuiz').onclick=()=>{if(!quiz||!confirm('পরীক্ষা থেকে বের হবে? Server-এ Save করা উত্তরগুলো attempt-এ থাকবে, তবে এখন result জমা হবে না।'))return;clearInterval(timerId);quiz=null;$id('quizModal').classList.add('hidden');};
async function finishQuiz(timeUp){if(!quiz||quiz.done)return;quiz.done=true;clearInterval(timerId);const qz=quiz;quiz=null;$id('quizModal').classList.add('hidden');
 try{let result;if(qz.mode==='exam'){try{await qz.saveQueue;}catch(_){}if(timeUp&&qz.sel!==null&&!qz.saving)await supabase.rpc('save_exam_answer',{p_attempt_id:qz.attemptId,p_question_id:qz.qs[qz.i].id,p_selected:qz.sel});const {data,error}=await supabase.rpc('submit_exam',{p_attempt_id:qz.attemptId});if(error)throw error;result=data;}else{const payload=qz.qs.map((q,i)=>({question_id:q.id,selected:qz.ans[i]}));const {data,error}=await supabase.rpc('submit_practice',{p_answers:payload,p_title:qz.title});if(error)throw error;result=data;}
 if(timeUp)toast('সময় শেষ। Server-এ Save হওয়া উত্তর দিয়ে পরীক্ষা জমা হয়েছে।');showResult(result);await loadData();
 }catch(e){toast('Result জমা হয়নি: '+e.message,'error');}}
async function showResult(r){$id('resTitle').textContent=r.title||'Result';$id('resBody').innerHTML=`<div class="result-summary"><h2>${r.score}/${r.total}</h2><p>${pct(r.score,r.total)}% · ${new Date(r.created_at||Date.now()).toLocaleString()}</p><button class="btn btn-sm" id="printThisResult">Print result</button></div><div id="reviewContent"><p class="empty">Answer review load হচ্ছে…</p></div>`;$id('resultModal').classList.remove('hidden');$id('printThisResult').onclick=()=>{document.body.classList.add('printing-result');window.print();document.body.classList.remove('printing-result');};
 const {data,error}=await supabase.rpc('get_result_review',{p_result_id:r.id});if(error){$id('reviewContent').innerHTML=`<p class="note">${esc(error.message)}। পরীক্ষা শেষ হওয়ার নির্ধারিত সময়ের আগে Answer Key দেখা যাবে না।</p>`;return;}
 const rows=data.answers||[];$id('reviewContent').innerHTML=`<h3>Answer Review</h3>${rows.map((a,i)=>`<article class="review"><h4>${i+1}. ${esc(a.text)}</h4><ol class="opts">${[a.option_a,a.option_b,a.option_c,a.option_d].map((o,n)=>`<li class="${n===a.answer?'ok':n===a.selected?'bad':''}"><b>${L[n]}</b><span>${esc(o)}</span></li>`).join('')}</ol><p class="${a.selected===a.answer?'tag-ok':'tag-bad'}">${a.selected===null?'উত্তর দাওনি':a.selected===a.answer?'সঠিক':'তোমার উত্তর: '+L[a.selected]}</p>${a.explanation?`<p class="note">${esc(a.explanation)}</p>`:''}</article>`).join('')}`;
}
$id('closeResult').onclick=()=>$id('resultModal').classList.add('hidden');
document.addEventListener('click',e=>{const id=e.target.closest('[data-review]')?.dataset.review;if(id){const r=results.find(x=>x.id===id);if(r)showResult(r);}});
$id('quickStart').onclick=()=>{const s=$id('quickSubject').value,n=+$id('quickCount').value;startPractice((s||'Mixed')+' practice',shuffle(questions.filter(q=>!s||q.subject===s)).slice(0,n));};
$id('practiceStart').onclick=()=>{const s=$id('practiceSubject').value,d=$id('practiceDifficulty').value,n=+$id('practiceCount').value;startPractice('Practice · '+(s||'All subjects'),shuffle(questions.filter(q=>(!s||q.subject===s)&&(!d||q.difficulty===d))).slice(0,n));};
$id('examList').onclick=e=>{const b=e.target.closest('[data-exam]');if(!b||b.disabled)return;openExamInfo(b.dataset.exam);};
$id('savedList').onclick=async e=>{const id=e.target.closest('[data-unsave]')?.dataset.unsave;if(!id)return;const {error}=await supabase.from('bookmarks').delete().eq('user_id',me.id).eq('question_id',id);if(error)return toast(error.message,'error');bookmarks.delete(id);renderSaved();};
$$('.nav button').forEach(b=>b.onclick=()=>{$$('.nav button').forEach(x=>x.classList.toggle('active',x===b));$$('.view').forEach(v=>v.classList.toggle('hidden',v.id!==b.dataset.view));});
$id('clearHistory').onclick=async()=>{if(!confirm('শুধু Practice history মুছবে? Official exam result ও ranking data অক্ষত থাকবে।'))return;const {data,error}=await supabase.rpc('clear_practice_history');if(error)return toast(error.message,'error');toast(`${data||0}টি Practice result মুছে ফেলা হয়েছে।`);await loadData();};
$id('printRanking').onclick=()=>{document.body.classList.add('printing-ranking');window.print();document.body.classList.remove('printing-ranking');};$id('printHistory').onclick=()=>{document.body.classList.add('printing-history');window.print();document.body.classList.remove('printing-history');};
boot();
