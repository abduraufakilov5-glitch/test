// ============================================================
//  auth.js — вход, выход, отслеживание сессии Supabase Auth
// ============================================================
import { supabaseClient } from './supabase.js';

/** Получить текущую сессию (или null) */
export async function getSession() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    console.error('getSession error', error);
    return null;
  }
  return data.session;
}

/** Вход по email + паролю */
export async function signIn(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

/** Выход */
export async function signOut() {
  const { error } = await supabaseClient.auth.signOut();
  if (error) throw error;
}

/** Подписка на изменения состояния авторизации */
export function onAuthStateChange(callback) {
  const { data } = supabaseClient.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return data.subscription;
}

/** id текущего пользователя, либо null */
export async function currentUserId() {
  const session = await getSession();
  return session?.user?.id ?? null;
}
