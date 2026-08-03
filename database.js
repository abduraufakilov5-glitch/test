import { supabaseClient } from './supabase.js';
import { toMinorUnits } from './utils.js';

const check = ({data,error}) => { if (error) throw error; return data; };
export async function fetchClients(){ return check(await supabaseClient.from('clients').select('*').order('name')); }
export async function createClient(v){ return check(await supabaseClient.from('clients').insert([{name:v.name.trim(),phone:v.phone?.trim()||null,notes:v.notes?.trim()||null}]).select().single()); }
export async function updateClient(id,v){ const safe={}; ['name','phone','notes'].forEach(k=>{if(k in v)safe[k]=v[k]?.trim()||null}); if('name'in safe&&!safe.name) throw new Error('Имя обязательно'); return check(await supabaseClient.from('clients').update(safe).eq('id',id).select().single()); }
export async function deleteClient(id){ return check(await supabaseClient.rpc('delete_empty_client',{p_client_id:id})); }
export async function fetchAllTransactions(){ return check(await supabaseClient.from('transactions').select('id,client_id,type,amount,description,transaction_date,created_at,idempotency_key').order('transaction_date',{ascending:false}).order('created_at',{ascending:false})); }
export async function createTransaction(v){ return check(await supabaseClient.rpc('create_transaction',{p_client_id:v.client_id,p_type:v.type,p_amount:String(v.amount),p_description:v.description||null,p_transaction_date:v.transaction_date,p_idempotency_key:v.idempotency_key})); }
export function computeBalances(rows){ const m=new Map(); for(const t of rows){const e=m.get(t.client_id)||{balanceMinor:0,lastDate:null}; const n=toMinorUnits(t.amount); e.balanceMinor+=t.type==='PAYMENT'?-n:n; if(!e.lastDate||t.transaction_date>e.lastDate)e.lastDate=t.transaction_date;m.set(t.client_id,e)} return m; }
export async function getMigrationStatus(){ return check(await supabaseClient.from('migration_status').select('*').maybeSingle()); }
export async function importInitialDebts(){ return check(await supabaseClient.rpc('import_initial_debts')); }
export async function restoreBackup(b){ return check(await supabaseClient.rpc('restore_backup',{p_backup:b})); }

export async function fetchProducts(){ return check(await supabaseClient.from('products').select('*').order('active',{ascending:false}).order('name')); }
export async function saveProduct(v){ if(v.id) return check(await supabaseClient.from('products').update(v).eq('id',v.id).select().single()); return check(await supabaseClient.from('products').insert([v]).select().single()); }
export async function fetchSales(from,to){ let q=supabaseClient.from('sales').select('*, sale_items(*)').order('sale_date',{ascending:false}).order('created_at',{ascending:false}); if(from)q=q.gte('sale_date',from);if(to)q=q.lte('sale_date',to); return check(await q); }
export async function createSale(v){ return check(await supabaseClient.rpc('create_sale',{p_amount:String(v.amount),p_description:v.description||null,p_quantity:v.quantity||1,p_payment_method:v.payment_method,p_sale_date:v.sale_date,p_product_id:v.product_id||null,p_client_id:v.client_id||null,p_idempotency_key:v.idempotency_key})); }
export async function cancelSale(id){ return check(await supabaseClient.rpc('cancel_sale',{p_sale_id:id})); }
export async function fetchExpenses(from,to){ let q=supabaseClient.from('expenses').select('*').order('expense_date',{ascending:false}).order('created_at',{ascending:false});if(from)q=q.gte('expense_date',from);if(to)q=q.lte('expense_date',to);return check(await q); }
export async function createExpense(v){ return check(await supabaseClient.from('expenses').insert([v]).select().single()); }
export async function cancelExpense(id){ return check(await supabaseClient.from('expenses').update({status:'cancelled'}).eq('id',id).select().single()); }
export async function fetchPurchases(from,to){ let q=supabaseClient.from('purchases').select('*, products(name)').order('purchase_date',{ascending:false});if(from)q=q.gte('purchase_date',from);if(to)q=q.lte('purchase_date',to);return check(await q); }
export async function createPurchase(v){ return check(await supabaseClient.rpc('create_purchase',{p_product_id:v.product_id,p_quantity:v.quantity,p_unit_cost:String(v.unit_cost),p_supplier:v.supplier||null,p_comment:v.comment||null,p_purchase_date:v.purchase_date,p_idempotency_key:v.idempotency_key})); }
export async function cancelPurchase(id){ return check(await supabaseClient.rpc('cancel_purchase',{p_purchase_id:id})); }
