/**
 * Service worker — full-site offline for a static-exported Next.js site.
 *
 * Strategy:
 *   • On install → fetch /precache-manifest.json (built alongside `out/`),
 *     then cache every HTML route + every /_next/static asset + every image
 *     listed. Works because everything in `out/` is finite and small-ish.
 *   • At runtime → cache-first for everything (assets rarely change because
 *     Next hashes them; HTML revalidates on next online visit).
 *   • Cross-origin Google Fonts are cached opportunistically when requested.
 *
 * To update the cache after deploy: bump VERSION.
 */
const VERSION = "guide-v10";
const STATIC_CACHE = `static-${VERSION}`;
const HTML_CACHE = `html-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;
const IMAGE_CACHE = `images-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const manifestRes = await fetch("/precache-manifest.json", { cache: "reload" });
        if (!manifestRes.ok) {
          console.warn("[sw] precache manifest fetch failed", manifestRes.status);
          self.skipWaiting();
          return;
        }
        const manifest = await manifestRes.json();
        const htmlCache = await caches.open(HTML_CACHE);
        const staticCache = await caches.open(STATIC_CACHE);
        const imageCache = await caches.open(IMAGE_CACHE);

        const PAR = 8;
        async function batch(list, cache) {
          let idx = 0;
          async function worker() {
            while (idx < list.length) {
              const url = list[idx++];
              try {
                if (await cache.match(url)) continue;
                const res = await fetch(url, { cache: "reload" });
                if (res.ok) await cache.put(url, res);
              } catch {}
              if (idx % 50 === 0) broadcast({ type: "PRECACHE_PROGRESS", done: idx, total: list.length });
            }
          }
          await Promise.all(Array.from({ length: PAR }, worker));
          broadcast({ type: "PRECACHE_PROGRESS", done: list.length, total: list.length });
        }

        const htmlList = manifest.html || [];
        const assetList = manifest.assets || [];
        const imageList = assetList.filter((u) => u.startsWith("/img/"));
        const otherAssets = assetList.filter((u) => !u.startsWith("/img/"));
        const total = htmlList.length + assetList.length;

        broadcast({ type: "PRECACHE_START", total });
        // Assets first (JS/CSS/fonts) so navigations have deps ready.
        await batch(otherAssets, staticCache);
        await batch(htmlList, htmlCache);
        await batch(imageList, imageCache);
        broadcast({ type: "PRECACHE_DONE", total });
      } catch (e) {
        console.warn("[sw] install error", e);
      } finally {
        self.skipWaiting();
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function broadcast(msg) {
  self.clients.matchAll({ includeUncontrolled: true }).then((cs) => {
    for (const c of cs) {
      try { c.postMessage(msg); } catch {}
    }
  });
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "SKIP_WAITING") self.skipWaiting();
});

/* ---------------- fetch ---------------- */

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  const isSame = url.origin === self.location.origin;
  const isGoogleFonts =
    url.origin === "https://fonts.googleapis.com" ||
    url.origin === "https://fonts.gstatic.com";
  if (!isSame && !isGoogleFonts) return;

  // Strip Next's RSC query for cache lookup (static export doesn't use RSC
  // prefetch, but older cached versions may still generate these).
  if (isSame && url.searchParams.has("_rsc")) {
    event.respondWith(
      (async () => {
        try { return await fetch(req); } catch {
          return new Response("", { status: 200, headers: { "content-type": "text/x-component" } });
        }
      })(),
    );
    return;
  }

  if (isSame && url.pathname.startsWith("/img/")) {
    event.respondWith(cacheFirst(req, IMAGE_CACHE));
    return;
  }

  if (isSame && url.pathname === "/handbook.json") {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }
  if (isSame && url.pathname === "/precache-manifest.json") {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }

  // Navigation to a .txt URL (happens if Next's soft-nav somehow landed the
  // browser on an RSC payload) — serve the matching .html instead so the user
  // never sees raw RSC text.
  if (
    isSame &&
    url.pathname.endsWith(".txt") &&
    (req.mode === "navigate" || req.destination === "document")
  ) {
    event.respondWith(
      (async () => {
        const htmlUrl = new URL(req.url);
        htmlUrl.pathname = htmlUrl.pathname.slice(0, -".txt".length);
        const htmlCache = await caches.open(HTML_CACHE);
        const cached =
          (await htmlCache.match(htmlUrl.toString(), { ignoreSearch: true })) ||
          (await caches.match(htmlUrl.toString(), { ignoreSearch: true }));
        if (cached) return cached;
        try {
          const res = await fetch(htmlUrl.toString());
          if (res.ok) return res;
        } catch {}
        return missingPage(htmlUrl);
      })(),
    );
    return;
  }

  if (
    isSame &&
    (url.pathname.startsWith("/_next/") ||
      url.pathname.endsWith(".js") ||
      url.pathname.endsWith(".css") ||
      url.pathname.endsWith(".woff") ||
      url.pathname.endsWith(".woff2") ||
      url.pathname.endsWith(".txt")) // Next.js RSC payloads
  ) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  if (isGoogleFonts) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  if (
    isSame &&
    (url.pathname.endsWith(".png") ||
      url.pathname.endsWith(".jpg") ||
      url.pathname.endsWith(".webp") ||
      url.pathname.endsWith(".webmanifest") ||
      url.pathname.endsWith(".ico") ||
      url.pathname.endsWith(".svg"))
  ) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  if (req.mode === "navigate" || req.headers.get("accept")?.includes("text/html")) {
    event.respondWith(navigationHandler(req));
    return;
  }
});

async function navigationHandler(req) {
  const htmlCache = await caches.open(HTML_CACHE);
  // Cached HTML = instant render; revalidate in background.
  const cached = await htmlCache.match(req, { ignoreSearch: true });
  const network = fetch(req)
    .then((res) => {
      if (res.ok) htmlCache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    network.catch(() => {});
    return cached;
  }
  const fresh = await network;
  if (fresh && fresh.ok) return fresh;
  return missingPage(new URL(req.url));
}

function missingPage(url) {
  const path = escapeHtml(url.pathname + url.search);
  const html = `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ยังไม่มีข้อมูล</title><style>body{font-family:system-ui,sans-serif;background:#fdf8ec;color:#1c1410;margin:0;padding:40px 20px;text-align:center}.c{max-width:380px;margin:40px auto;background:#fff;padding:28px 22px;border-radius:16px;box-shadow:0 4px 24px rgba(120,53,15,.12)}h1{font-size:22px;color:#7c2d12;margin:0 0 10px}p{color:#78716c;margin:0 0 16px}code{background:#f7ecd0;padding:2px 8px;border-radius:6px;font-size:12px;word-break:break-all}a{display:inline-block;padding:10px 20px;background:#c2410c;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;margin-top:10px}</style><div class="c"><h1>ยังไม่มีข้อมูล</h1><p>หน้าที่ขอไม่อยู่ในคู่มือ</p><p><code>${path}</code></p><a href="/">กลับหน้าแรก</a></div>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === "opaque") cache.put(req, res.clone());
    return res;
  } catch {
    return new Response("offline", { status: 503, statusText: "offline" });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const refresh = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || (await refresh);
}
