import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { corsHeaders } from '../_shared/cors.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value || 'unknown');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '';
    const expectedPublicKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || anonKey;
    const suppliedPublicKey = req.headers.get('apikey') || '';
    if (!expectedPublicKey || suppliedPublicKey !== expectedPublicKey) return json({ error: 'Unauthorized' }, 401);
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    if (!url || !anonKey || !serviceKey) return json({ error: 'Server configuration missing' }, 500);
    const { identifier, password } = await req.json();
    const raw = String(identifier || '').trim();
    if (!raw || typeof password !== 'string' || password.length < 1 || raw.length > 254) {
      return json({ error: 'Email, username/phone এবং password দিতে হবে।' }, 400);
    }
    const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const ipHash = await sha256(ip);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    await admin.from('login_attempts').delete().lt('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    await admin.from('login_attempts').insert({ ip_hash: ipHash });
    const { count } = await admin.from('login_attempts').select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash).gte('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString());
    if ((count || 0) > 12) return json({ error: 'অনেকবার Login চেষ্টা হয়েছে। ১৫ মিনিট পরে আবার চেষ্টা করো।' }, 429);
    // Identifier resolution happens only on the server. The email address is never returned to the browser.
    let email = raw.toLowerCase();
    if (!raw.includes('@')) {
      let query = admin.from('profiles').select('email').limit(1);
      if (/^01[3-9]\d{8}$/.test(raw)) query = query.eq('phone', raw);
      else query = query.eq('username', raw.toLowerCase());
      const { data, error } = await query.maybeSingle();
      if (error || !data?.email) return json({ error: 'তথ্য অথবা পাসওয়ার্ড সঠিক নয়।' }, 401);
      email = data.email;
    }
    const publicClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await publicClient.auth.signInWithPassword({ email, password });
    if (error || !data.session) return json({ error: 'তথ্য অথবা পাসওয়ার্ড সঠিক নয়।' }, 401);
    return json({ session: data.session });
  } catch (_error) {
    return json({ error: 'Login service-এ সমস্যা হয়েছে। পরে আবার চেষ্টা করো।' }, 500);
  }
});
