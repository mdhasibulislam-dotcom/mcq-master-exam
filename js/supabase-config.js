
/* =========================================
   MCQ MASTER - SUPABASE CONFIGURATION
   ========================================= */

// Supabase project configuration
const SUPABASE_URL = 'https://gmmjryvcfwrayyplhhuz.supabase.co';

const SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_9JOF9zgcXGKzgksgUt7xdg_92pz2Yg5';

// Check Supabase library
if (!window.supabase || !window.supabase.createClient) {
  console.error('Supabase CDN failed to load.');
  window.supabaseConfigError = 'Supabase library load হয়নি।';
} else {
  try {
    // Remember Me uses localStorage; otherwise the session is tab-scoped.
    // Passwords are never stored by this application.
    const rememberKey = 'mcq_master_remember_me';
    let rememberSession = localStorage.getItem(rememberKey) === '1';
    const authStorage = {
      getItem(key) {
        return (rememberSession ? localStorage : sessionStorage).getItem(key);
      },
      setItem(key, value) {
        const primary = rememberSession ? localStorage : sessionStorage;
        const secondary = rememberSession ? sessionStorage : localStorage;
        secondary.removeItem(key);
        primary.setItem(key, value);
      },
      removeItem(key) {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      }
    };
    window.setAuthPersistence = remember => {
      rememberSession = Boolean(remember);
      localStorage.setItem(rememberKey, rememberSession ? '1' : '0');
    };
    window.getAuthPersistence = () => rememberSession;

    window.supabaseClient = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY,
      {
        auth: {
          storage: authStorage,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      }
    );

    console.log('Supabase connected successfully.');

  } catch (error) {
    console.error('Supabase initialization error:', error);
    window.supabaseConfigError = error.message;
  }
}

// Global client reference for existing scripts
const supabase = window.supabaseClient;

// =========================================
// GLOBAL HELPERS
// =========================================

const $ = (selector, root = document) =>
  root.querySelector(selector);

const $$ = (selector, root = document) =>
  [...root.querySelectorAll(selector)];

const esc = (value = '') =>
  String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);

// Toast notification
const toast = (message, kind = '') => {
  let element = $('#toast');

  if (!element) {
    element = document.createElement('div');
    element.id = 'toast';
    document.body.append(element);
  }

  element.textContent = message;
  element.className = 'toast show ' + kind;

  clearTimeout(window.__toastTimer);

  window.__toastTimer = setTimeout(() => {
    element.className = 'toast';
  }, 3200);
};

// =========================================
// GET CURRENT USER PROFILE
// =========================================

async function currentProfile() {
  if (!window.supabaseClient) {
    throw new Error('Supabase Client পাওয়া যায়নি।');
  }

  const { data: { user }, error } =
    await window.supabaseClient.auth.getUser();

  if (error || !user) return null;

  const { data, error: profileError } =
    await window.supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

  if (profileError) throw profileError;

  return data;
}

// =========================================
// REQUIRE AUTHENTICATION
// =========================================

async function requireAuth(role) {
  const loginPage = role === 'admin' ? 'admin-login.html' : 'index.html';

  if (!window.supabaseClient) {
    location.replace(loginPage);
    return null;
  }

  const { data: { session }, error } =
    await window.supabaseClient.auth.getSession();

  if (error) throw error;

  if (!session) {
    location.replace(loginPage);
    return null;
  }

  const profile = await currentProfile();

  if (!profile) {
    toast(
      'Profile পাওয়া যায়নি। SQL schema/trigger check করো।',
      'error'
    );
    return null;
  }

  if (role && profile.role !== role) {
    location.replace(
      profile.role === 'admin'
        ? 'admin.html'
        : 'student.html'
    );

    return null;
  }

  return profile;
}

// =========================================
// LOGOUT
// =========================================

async function logout() {
  if (!window.supabaseClient) return;

  const { error } =
    await window.supabaseClient.auth.signOut();

  if (error) {
    toast(error.message, 'error');
    return;
  }

  // Admin panel sign-out goes back to the admin login page
  location.replace(/admin\.html$/.test(location.pathname) ? 'admin-login.html' : 'index.html');
}

// Fetch every row (Supabase returns max 1000 per request).
// make() must return a fresh query each time, with a stable order.
async function fetchAll(make) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const shuffle = list => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
