/* MCQ Master — Admin Console login. Same Supabase Edge Function as the student login, but only role=admin may enter. */
(() => {
  'use strict';
  const $id = id => document.getElementById(id);
  const form = $id('alForm'), msg = $id('alMessage'), btn = $id('alSubmit');
  const client = () => {
    if (window.supabaseConfigError) throw new Error(window.supabaseConfigError);
    if (!window.supabaseClient) throw new Error('Supabase Client তৈরি হয়নি।');
    return window.supabaseClient;
  };
  const say = (t, type = 'info') => { msg.textContent = t; msg.className = `al-msg show ${type}`; };
  const clearMsg = () => { msg.textContent = ''; msg.className = 'al-msg'; };
  const readable = e => {
    const m = e?.message || String(e);
    if (/invalid login credentials|invalid identifier/i.test(m)) return 'তথ্য অথবা পাসওয়ার্ড সঠিক নয়।';
    if (/email not confirmed/i.test(m)) return 'লগইনের আগে ইমেইল কনফার্ম করো।';
    if (/failed to fetch|networkerror|load failed/i.test(m)) return 'ইন্টারনেট অথবা Supabase connection পরীক্ষা করো।';
    return m;
  };
  const setBusy = on => {
    btn.disabled = on;
    btn.querySelector('span').textContent = on ? 'অপেক্ষা করো…' : 'Admin Console-এ ঢোকো';
  };

  // remember me
  const remember = $id('alRemember');
  remember.checked = Boolean(window.getAuthPersistence?.());
  remember.addEventListener('change', () => window.setAuthPersistence?.(remember.checked));

  // show / hide password
  $id('alEye').addEventListener('click', e => {
    const input = $id('alPass'), show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'লুকাও' : 'দেখাও';
  });

  // forgot password (email only)
  $id('alForgot').addEventListener('click', async () => {
    const email = $id('alId').value.trim();
    if (!email.includes('@')) return say('Password reset করতে ইমেইল অ্যাড্রেস লিখতে হবে।', 'error');
    try {
      const base = location.origin + location.pathname.replace(/[^/]*$/, '');
      const { error } = await client().auth.resetPasswordForEmail(email, { redirectTo: base + 'reset.html' });
      if (error) throw error;
      say('Password reset link পাঠানো হয়েছে। Inbox ও Spam folder দেখো।', 'success');
    } catch (e) { say(readable(e), 'error'); }
  });

  async function roleOf(userId) {
    const { data, error } = await client().from('profiles').select('role').eq('id', userId).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Profile পাওয়া যায়নি। Database migration চালানো হয়েছে কি না দেখো।');
    return data.role;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault(); clearMsg();
    const identifier = $id('alId').value.trim(), password = $id('alPass').value;
    if (!identifier || !password) return say('ইমেইল/Username এবং পাসওয়ার্ড লিখতে হবে।', 'error');
    setBusy(true);
    try {
      const c = client();
      window.setAuthPersistence?.(remember.checked);
      await c.auth.signOut({ scope: 'local' });
      const { data, error } = await c.functions.invoke('login-with-identifier', { body: { identifier, password } });
      if (error) throw error;
      if (!data?.session) throw new Error(data?.error || 'লগইন করা যায়নি।');
      const { data: s, error: setErr } = await c.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
      if (setErr) throw setErr;
      if ((await roleOf(s.user.id)) !== 'admin') {
        await c.auth.signOut({ scope: 'local' });
        throw new Error('এই অ্যাকাউন্টে Admin অ্যাক্সেস নেই। স্টুডেন্ট হলে স্টুডেন্ট পোর্টালে লগইন করো।');
      }
      say('লগইন সফল হয়েছে। Admin Console খুলছে…', 'success');
      location.replace('admin.html');
    } catch (err) {
      console.error('Admin login error', err);
      say(readable(err), 'error');
      setBusy(false);
    }
  });

  // already signed in as admin → straight to the panel
  (async () => {
    try {
      const { data } = await client().auth.getSession();
      if (data.session && (await roleOf(data.session.user.id)) === 'admin') location.replace('admin.html');
    } catch (_) { /* stay on the login page */ }
  })();
})();
