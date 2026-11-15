/* Admin: bulk import questions from CSV / pasted Excel or Google Sheets rows */
const BULK_REQUIRED = ['text', 'option_a', 'option_b', 'option_c', 'option_d', 'answer', 'subject'];
const BULK_ALIAS = { question: 'text', q: 'text', a: 'option_a', b: 'option_b', c: 'option_c', d: 'option_d',
  correct: 'answer', correct_answer: 'answer', level: 'difficulty', chapter_name: 'chapter' };

function parseCSV(t, d) {
  const rows = []; let row = [], f = '', q = false;
  t = t.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"' && f === '') q = true;
    else if (c === d) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

function analyzeCSV(text, existingTexts) {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '';
  const delim = first.includes('\t') ? '\t' : (first.includes(',') ? ',' : (first.includes(';') ? ';' : ','));
  const rows = parseCSV(text, delim);
  if (rows.length < 2) return { error: 'কমপক্ষে একটা header লাইন আর একটা প্রশ্নের লাইন লাগবে।', items: [] };
  const header = rows[0].map(h => { h = h.trim().toLowerCase().replace(/\s+/g, '_'); return BULK_ALIAS[h] || h; });
  const missing = BULK_REQUIRED.filter(c => !header.includes(c));
  if (missing.length) return { error: 'এই কলামগুলো নেই: ' + missing.join(', '), items: [] };
  const seen = new Set(existingTexts.map(s => s.trim().toLowerCase()));
  const items = rows.slice(1).map((r, k) => {
    const o = {}; header.forEach((h, i) => o[h] = (r[i] || '').trim());
    const n = k + 2, snippet = o.text.slice(0, 60);
    const bad = reason => ({ n, status: 'bad', reason, text: snippet });
    if (!o.text) return bad('প্রশ্ন খালি');
    if (!o.option_a || !o.option_b || !o.option_c || !o.option_d) return bad('চারটা অপশনই লাগবে');
    const idx = 'ABCD'.indexOf(o.answer.toUpperCase());
    if (o.answer.length !== 1 || idx < 0) return bad('answer হতে হবে A, B, C বা D (পেয়েছি: “' + o.answer + '”)');
    if (!o.subject) return bad('subject খালি');
    let diff = o.difficulty ? o.difficulty[0].toUpperCase() + o.difficulty.slice(1).toLowerCase() : 'Medium';
    if (!['Easy', 'Medium', 'Hard'].includes(diff)) return bad('difficulty হতে হবে Easy, Medium বা Hard');
    const key = o.text.toLowerCase();
    if (seen.has(key)) return { n, status: 'dup', reason: 'আগে থেকেই আছে, বাদ যাবে', text: snippet };
    seen.add(key);
    return { n, status: 'ok', text: snippet, payload: { text: o.text, option_a: o.option_a, option_b: o.option_b, option_c: o.option_c,
      option_d: o.option_d, answer: idx, subject: o.subject, difficulty: diff, tag: o.tag || '', explanation: o.explanation || '', chapter: o.chapter || '' } };
  });
  return { items };
}

// ---- UI
(() => {
  let ready = [];
  const modal = $('#importModal');
  const close = () => modal.classList.add('hidden');

  function check() {
    const text = $('#csvText').value;
    ready = [];
    if (!text.trim()) { $('#importSummary').textContent = ''; $('#importPreview').innerHTML = ''; $('#importGo').disabled = true; $('#importGo').textContent = 'Import'; return; }
    const res = analyzeCSV(text, questions.map(q => q.text));
    if (res.error) { $('#importSummary').innerHTML = `<span class="tag-bad">${esc(res.error)}</span>`; $('#importPreview').innerHTML = ''; $('#importGo').disabled = true; return; }
    const ok = res.items.filter(i => i.status === 'ok'), dup = res.items.filter(i => i.status === 'dup'), bad = res.items.filter(i => i.status === 'bad');
    ready = ok.map(i => i.payload);
    $('#importSummary').innerHTML = `<b class="tag-ok">${ok.length} ready</b> · ${dup.length} duplicate · <span class="${bad.length ? 'tag-bad' : ''}">${bad.length} invalid</span>`;
    $('#importPreview').innerHTML = [...bad, ...dup, ...ok].slice(0, 40).map(i =>
      `<div class="imp-row ${i.status}">Row ${i.n}: ${esc(i.text)}${i.reason ? ' — ' + esc(i.reason) : ''}</div>`).join('') +
      (res.items.length > 40 ? `<p class="sub">…আরও ${res.items.length - 40}টি লাইন</p>` : '');
    $('#importGo').disabled = !ready.length;
    $('#importGo').textContent = ready.length ? `Import ${ready.length} questions` : 'Import';
  }

  $('#importBtn').onclick = () => { $('#csvText').value = ''; $('#csvFile').value = ''; check(); modal.classList.remove('hidden'); };
  $('#closeImport').onclick = $('#cancelImport').onclick = close;
  $('#csvText').oninput = check;
  $('#csvFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    $('#csvText').value = await f.text(); check();
  };
  $('#csvTemplate').onclick = () => {
    const rows = [['text', 'option_a', 'option_b', 'option_c', 'option_d', 'answer', 'subject', 'difficulty', 'tag', 'chapter', 'explanation']];
    const csv = rows.map(r => r.map(c => /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'mcq-template.csv'; document.body.append(a); a.click(); a.remove();
  };
  $('#importGo').onclick = async () => {
    if (!ready.length) return;
    const btn = $('#importGo'); btn.disabled = true; btn.textContent = 'Importing…';
    let saved = 0;
    for (let i = 0; i < ready.length; i += 200) {
      const batch = ready.slice(i, i + 200).map(p => ({ ...p, created_by: me.id }));
      const { error } = await supabase.from('questions').insert(batch);
      if (error) { toast(`${saved}টি save হয়েছে, তারপর error: ${error.message}`, 'error'); await loadAll(); check(); return; }
      saved += batch.length;
    }
    close(); toast(`${saved}টি প্রশ্ন যোগ হয়েছে`); await loadAll();
  };
})();
