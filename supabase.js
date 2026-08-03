// ============================================================
//  supabase.js — инициализация клиента Supabase
//
//  !!! ВСТАВЬТЕ СЮДА СВОИ ДАННЫЕ ИЗ SUPABASE (Project Settings -> API) !!!
//  Используйте ТОЛЬКО Project URL и anon/public key.
//  НИКОГДА не вставляйте сюда service_role key — это секретный
//  ключ с полным доступом, ему не место во frontend-коде.
// ============================================================

const SUPABASE_URL = 'https://adviprrgbitenfubczfn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_SFjC8cschOIeirqKBTpg6w_-ZlWQ7fH';

if (typeof window.supabase === 'undefined') {
  throw new Error(
    'Библиотека Supabase не загружена. Проверьте, что <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script> подключён в index.html до app.js.'
  );
}

export const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

export const isConfigured = () =>
  !SUPABASE_URL.includes('YOUR-PROJECT-REF') && !SUPABASE_ANON_KEY.includes('YOUR-ANON-PUBLIC-KEY');
