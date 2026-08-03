const CACHE_NAME = 'dolgi-shell-v3-premium-ui';
const REQUIRED_SHELL = ['./', './index.html', './styles.css', './app.js', './supabase.js', './auth.js', './database.js', './utils.js', './manifest.json'];
const OPTIONAL_SHELL = ['./icons/icon-192.png', './icons/icon-512.png', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'];
self.addEventListener('install', event => event.waitUntil((async()=>{const cache=await caches.open(CACHE_NAME);await cache.addAll(REQUIRED_SHELL);await Promise.allSettled(OPTIONAL_SHELL.map(u=>cache.add(u)));await self.skipWaiting()})()));
self.addEventListener('activate', event => event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)));await self.clients.claim()})()));
self.addEventListener('fetch', event=>{
  const req=event.request;if(req.method!=='GET')return;const url=new URL(req.url);
  if(url.hostname.endsWith('.supabase.co')||url.hostname.endsWith('.supabase.in'))return;
  const sameOrigin=url.origin===self.location.origin;const isSupabaseLibrary=url.hostname==='cdn.jsdelivr.net'&&url.pathname.includes('@supabase/supabase-js');
  if(!sameOrigin&&!isSupabaseLibrary)return;
  event.respondWith((async()=>{
    try{const response=await fetch(req);if(response.ok){const cache=await caches.open(CACHE_NAME);cache.put(req,response.clone()).catch(()=>{})}return response}
    catch(err){const cached=await caches.match(req);if(cached)return cached;if(req.mode==='navigate')return(await caches.match('./index.html'))||Response.error();throw err}
  })());
});
