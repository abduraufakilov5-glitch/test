import { supabaseClient } from './supabase.js';
import { toMinorUnits } from './utils.js';

export async function fetchClients() {
  const { data, error } = await supabaseClient.from('clients').select('*').order('name', { ascending: true });
  if (error) throw error;
  return data;
}

export async function createClient({ name, phone = null, notes = null }) {
  const { data, error } = await supabaseClient.from('clients')
    .insert([{ name: name.trim(), phone: phone?.trim() || null, notes: notes?.trim() || null }])
    .select().single();
  if (error) throw error;
  return data;
}

export async function updateClient(id, fields) {
  const safe = {};
  if ('name' in fields) safe.name = String(fields.name).trim();
  if ('phone' in fields) safe.phone = fields.phone?.trim() || null;
  if ('notes' in fields) safe.notes = fields.notes?.trim() || null;
  const { data, error } = await supabaseClient.from('clients').update(safe).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteClient(id) {
  const { data, error } = await supabaseClient.rpc('delete_empty_client', { p_client_id: id });
  if (error) throw error;
  return data;
}

export async function fetchAllTransactions() {
  const { data, error } = await supabaseClient.from('transactions')
    .select('id, client_id, type, amount, description, transaction_date, created_at, idempotency_key')
    .order('transaction_date', { ascending: false }).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function createTransaction({ client_id, type, amount, description = null, transaction_date, idempotency_key }) {
  const { data, error } = await supabaseClient.rpc('create_transaction', {
    p_client_id: client_id,
    p_type: type,
    p_amount: String(amount),
    p_description: description || null,
    p_transaction_date: transaction_date,
    p_idempotency_key: idempotency_key,
  });
  if (error) throw error;
  return data;
}

export function computeBalances(transactions) {
  const map = new Map();
  for (const tx of transactions) {
    const entry = map.get(tx.client_id) || { balanceMinor: 0, lastDate: null };
    const minor = toMinorUnits(tx.amount);
    if (tx.type === 'DEBT') entry.balanceMinor += minor;
    else if (tx.type === 'PAYMENT') entry.balanceMinor -= minor;
    else if (tx.type === 'ADJUSTMENT') entry.balanceMinor += minor;
    if (!entry.lastDate || tx.transaction_date > entry.lastDate) entry.lastDate = tx.transaction_date;
    map.set(tx.client_id, entry);
  }
  return map;
}

export async function getMigrationStatus() {
  const { data, error } = await supabaseClient.from('migration_status').select('*').maybeSingle();
  if (error) throw error;
  return data;
}

export async function importInitialDebts() {
  const { data, error } = await supabaseClient.rpc('import_initial_debts');
  if (error) throw error;
  return data;
}

export async function restoreBackup(backup) {
  const { data, error } = await supabaseClient.rpc('restore_backup', { p_backup: backup });
  if (error) throw error;
  return data;
}
