/* Shared Profile sheet (admin + student): photo, details, password, sign out.
   Replaces the old header Logout button — Sign out now lives at the bottom of this sheet. */
(() => {
  const LEVELS = ['ক্লাস ৬–৮', 'এসএসসি', 'এইচএসসি', 'ভর্তি পরীক্ষা', 'চাকরির প্রস্তুতি', 'অন্যান্য'];
  const initialOf = p => ((p?.first_name || p?.username || '?').trim().charAt(0) || '?').toUpperCase();

  function paintAvatar(el, p, src) {
    if (!el) return;
    el.textContent = '';
    const photo = src !== undefined ? src : p?.avatar_url;
    if (photo) { const im = document.createElement('img'); im.src = photo; im.alt = ''; el.appendChild(im); }
    else el.textContent = initialOf(p);
  }

  function resizeImage(file, size = 256) {
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(img.width, img.height), c = document.createElement('canvas');
        c.width = c.height = size;
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('ছবি পড়া যায়নি।')); };
      img.src = url;
    });
  }

  document.body.insertAdjacentHTML('beforeend', `
  <div id="profileModal" class="modal hidden"><div class="sheet pf-sheet">
    <div class="sheet-head"><h2>আমার প্রোফাইল</h2><button class="btn btn-sm" id="closeProfile" aria-label="Close">✕</button></div>
    <form id="profileForm" novalidate>
      <div class="pf-top">
        <div class="pf-avatar" id="pAv">?</div>
        <div class="pf-photo-btns">
          <div class="row"><label class="btn btn-sm" for="pPhoto" style="margin:0">ছবি বাছাই করো</label><button type="button" class="btn btn-sm danger" id="pPhotoRemove">ছবি মুছো</button></div>
          <input class="pf-file" id="pPhoto" type="file" accept="image/*" aria-label="ছবি বাছাই করো">
          <span class="hint">ছবি দেওয়া ঐচ্ছিক</span>
        </div>
      </div>
      <div class="pf-grid">
        <div class="pf-f"><label class="req" for="pFirst">নামের প্রথম অংশ</label><input id="pFirst" maxlength="40" autocomplete="given-name"><div class="pf-err"></div></div>
        <div class="pf-f"><label for="pLast">শেষ অংশ</label><input id="pLast" maxlength="40" autocomplete="family-name"><div class="pf-err"></div></div>
        <div class="pf-f"><label for="pPhone">মোবাইল নম্বর</label><input id="pPhone" type="tel" inputmode="numeric" placeholder="01XXXXXXXXX" maxlength="14" autocomplete="tel"><div class="pf-err"></div></div>
        <div class="pf-f"><label for="pUser">Username</label><input id="pUser" disabled></div>
        <div class="pf-f wide"><label for="pEmail">ইমেইল</label><input id="pEmail" disabled></div>
        <div class="pf-f student-only"><label for="pLevel">কোন লেভেলের জন্য পড়ছ?</label><select id="pLevel"><option value="">বাছাই করো</option>${LEVELS.map(l => `<option>${l}</option>`).join('')}</select></div>
        <div class="pf-f student-only"><label for="pDistrict">জেলা</label><input id="pDistrict" maxlength="60" autocomplete="address-level2"></div>
        <div class="pf-f wide student-only"><label for="pInst">স্কুল / কলেজ</label><input id="pInst" maxlength="120"></div>
      </div>
      <button class="btn btn-primary pf-save" type="submit">Save profile</button>
    </form>
    <details class="pf-pass"><summary>পাসওয়ার্ড পরিবর্তন</summary>
      <form id="passForm">
        <div class="pf-f"><label for="pCur">বর্তমান পাসওয়ার্ড</label><input id="pCur" type="password" autocomplete="current-password" required></div>
        <div class="pf-grid">
          <div class="pf-f"><label for="pNew">নতুন পাসওয়ার্ড</label><input id="pNew" type="password" minlength="8" autocomplete="new-password" required></div>
          <div class="pf-f"><label for="pNew2">আবার লেখো</label><input id="pNew2" type="password" minlength="8" autocomplete="new-password" required></div>
        </div>
        <button class="btn btn-primary" type="submit" style="width:100%;padding:12px">Update password</button>
      </form>
    </details>
    <button class="btn danger pf-signout" id="profileSignOut" type="button">Sign out</button>
  </div></div>`);

  const modal = $('#profileModal');
  let profile = null, photo; // photo: undefined = unchanged, '' = removed, string = new image
  const close = () => modal.classList.add('hidden');
  const fieldErr = (id, msg) => {
    const el = $('#' + id); el.classList.toggle('bad', !!msg);
    const box = el.closest('.pf-f')?.querySelector('.pf-err'); if (box) box.textContent = msg || '';
    return !msg;
  };
  const normPhone = v => v.replace(/[\s-]/g, '').replace(/^\+?88(?=01)/, '');

  // header avatar
  currentProfile().then(p => { if (p) { profile = p; paintAvatar($('#headerAv'), p); } }).catch(() => {});

  async function open() {
    try {
      profile = await currentProfile();
      if (!profile) return toast('Profile পাওয়া যায়নি।', 'error');
      photo = undefined;
      $('#pFirst').value = profile.first_name || '';
      $('#pLast').value = profile.last_name || '';
      $('#pPhone').value = profile.phone || '';
      $('#pUser').value = '@' + profile.username;
      $('#pEmail').value = profile.email;
      $('#pLevel').value = profile.level || '';
      $('#pInst').value = profile.institution || '';
      $('#pDistrict').value = profile.district || '';
      $$('.student-only', modal).forEach(el => el.classList.toggle('hidden', profile.role !== 'student'));
      ['pFirst', 'pPhone'].forEach(id => fieldErr(id, ''));
      $('#pCur').value = $('#pNew').value = $('#pNew2').value = '';
      $('.pf-pass', modal).open = false;
      paintAvatar($('#pAv'), profile);
      modal.classList.remove('hidden');
    } catch (e) { toast(e.message, 'error'); }
  }

  $('#profileBtn')?.addEventListener('click', open);
  $('#closeProfile').onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  $('#profileSignOut').onclick = () => logout();
  $('#pFirst').addEventListener('input', () => { if (photo === undefined && !profile?.avatar_url) paintAvatar($('#pAv'), { first_name: $('#pFirst').value }, ''); });

  $('#pPhoto').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) return toast('শুধু ছবি বাছাই করো।', 'error');
    if (f.size > 8 * 1024 * 1024) return toast('ছবি ৮MB-এর কম হতে হবে।', 'error');
    try { photo = await resizeImage(f); paintAvatar($('#pAv'), profile, photo); } catch (err) { toast(err.message, 'error'); }
  });
  $('#pPhotoRemove').onclick = () => { photo = ''; paintAvatar($('#pAv'), { first_name: $('#pFirst').value || profile?.first_name }, ''); };

  $('#profileForm').onsubmit = async e => {
    e.preventDefault();
    const first = $('#pFirst').value.trim(), last = $('#pLast').value.trim(), phone = normPhone($('#pPhone').value.trim());
    const ok = [fieldErr('pFirst', first ? '' : 'নামের প্রথম অংশ লিখতে হবে।'),
                fieldErr('pPhone', !phone || /^01[3-9]\d{8}$/.test(phone) ? '' : 'সঠিক ১১ সংখ্যার মোবাইল নম্বর দাও অথবা ফাঁকা রাখো।')];
    if (ok.includes(false)) return toast('লাল চিহ্নিত ঘরগুলো ঠিক করো।', 'error');

    const basic = { first_name: first, last_name: last, phone: phone || null };
    const payload = { ...basic };
    if (photo !== undefined) payload.avatar_url = photo || null;
    if (profile.role === 'student') {
      payload.level = $('#pLevel').value || null;
      payload.institution = $('#pInst').value.trim() || null;
      payload.district = $('#pDistrict').value.trim() || null;
    }
    let { error } = await supabase.from('profiles').update(payload).eq('id', profile.id);
    let partial = false;
    if (error && /column|schema cache|permission denied/i.test(error.message)) {
      // sql/profile-upgrade.sql has not been run yet: save the original fields only
      ({ error } = await supabase.from('profiles').update(basic).eq('id', profile.id));
      partial = !error;
    }
    if (error) return toast(/duplicate|unique/i.test(error.message) ? 'এই ফোন নম্বর আগে থেকেই ব্যবহৃত হচ্ছে।' : error.message, 'error');
    profile = { ...profile, ...(partial ? basic : payload) };
    paintAvatar($('#headerAv'), profile);
    if (typeof me !== 'undefined' && me) me.first_name = first;
    const adminName = $('#adminName'), welcome = $('#welcome');
    if (adminName) adminName.textContent = `${first} · Admin`;
    if (welcome) welcome.textContent = `স্বাগতম, ${first}`;
    toast(partial ? 'নাম ও ফোন Save হয়েছে। ছবি/লেভেল Save করতে sql/profile-upgrade.sql চালাও।' : 'Profile Save হয়েছে');
  };

  $('#passForm').onsubmit = async e => {
    e.preventDefault();
    const cur = $('#pCur').value, next = $('#pNew').value;
    if (next.length < 8) return toast('নতুন password কমপক্ষে ৮ অক্ষরের হতে হবে।', 'error');
    if (next !== $('#pNew2').value) return toast('নতুন password দুইটা মেলেনি।', 'error');
    if (next === cur) return toast('নতুন password আগেরটার থেকে আলাদা হতে হবে।', 'error');
    const check = await supabase.auth.signInWithPassword({ email: profile.email, password: cur });
    if (check.error) return toast('বর্তমান password ঠিক নয়।', 'error');
    const { error } = await supabase.auth.updateUser({ password: next });
    if (error) return toast(error.message, 'error');
    await supabase.auth.signOut({ scope: 'others' }); // other devices must log in again
    $('#pCur').value = $('#pNew').value = $('#pNew2').value = '';
    toast('Password বদলেছে');
  };
})();
