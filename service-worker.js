const CACHE_NAME='magazin-shell-v4-20260803';
const SHELL=['./','./index.html','./styles.css','./app.js','./supabase.js','./auth.js','./database.js','./utils.js','./manifest.json'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.hostname.endsWith('.supabase.co')||u.hostname.endsWith('.supabase.in'))return;if(u.origin!==self.location.origin)return;e.respondWith(fetch(r).then(x=>{if(x.ok)caches.open(CACHE_NAME).then(c=>c.put(r,x.clone()));return x}).catch(()=>caches.match(r).then(x=>x||(r.mode==='navigate'?caches.match('./index.html'):Response.error()))));});
