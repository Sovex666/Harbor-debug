const http = require("node:http");
const fs = require("node:fs");
const port = Number(process.env.HARBOR_FIXTURE_PORT || 1422);
const vitePort = Number(process.env.HARBOR_FIXTURE_VITE_PORT || 1420);
if (![port, vitePort].every((p) => Number.isInteger(p) && p > 0 && p < 65536))
  throw new Error("Invalid loopback fixture ports");
const snapshot = JSON.parse(
  fs.readFileSync(
    require("node:path").resolve(__dirname, "../../.diag/browser-inject.json"),
    "utf8",
  ),
);
// Import account configuration and user state, never derived media caches.
snapshot.storage = Object.fromEntries(
  Object.entries(snapshot.storage).filter(([key]) =>
    /^harbor\.(settings|profiles\.|auth\.|onboarding$|addonOrder$|installed-addons\.|addons\.|manual|favorites|watchlist|resume|localcw|moviewatched|watchevents|playback-history)/.test(
      key,
    ),
  ),
);
const bootstrap = `(() => { const s=${JSON.stringify(snapshot).replaceAll("<", "\\u003c")}; if(localStorage.getItem('harbor.browserProfile.imported') !== s.createdAt) {for (const [k,v] of Object.entries(s.storage)) localStorage.setItem(k,v); localStorage.setItem('harbor.browserProfile.imported',s.createdAt);} const originalFetch=window.fetch.bind(window); window.fetch=async (input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href); if(u.hostname!=='api.strem.io') return originalFetch(input,init); let body={}; try{body=JSON.parse(init?.body||'{}')}catch{}; let result; if(u.pathname.endsWith('/getUser')) result=s.user; else if(u.pathname.endsWith('/addonCollectionGet')) result={addons:s.addons}; else if(u.pathname.endsWith('/datastoreMeta')&&body.collection==='libraryItem') result=s.library.map(x=>[x._id,x._mtime]); else if(u.pathname.endsWith('/datastoreGet')&&body.collection==='libraryItem') result=s.library.filter(x=>!body.ids||body.ids.includes(x._id)); else return new Response(JSON.stringify({error:{message:'Read-only browser snapshot operation unavailable'}}),{status:403,headers:{'Content-Type':'application/json'}}); return new Response(JSON.stringify({result}),{headers:{'Content-Type':'application/json'}});}; window.__HARBOR_BROWSER_PROFILE__={libraryItems:s.libraryItems,createdAt:s.createdAt,accountAddons:s.addons.length,calendarApi:'local-snapshot'}; })();`;
http
  .createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403);
      return res.end();
    }
    if (
      req.headers["sec-fetch-site"] &&
      !["same-origin", "none"].includes(req.headers["sec-fetch-site"])
    ) {
      res.writeHead(403);
      return res.end();
    }
    if (req.url === "/__snapshot.js") {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
      return res.end(bootstrap);
    }
    if (req.url === "/__benchmark-empty") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      return res.end("<!doctype html><html><head></head><body></body></html>");
    }
    try {
      const r = await fetch(`http://127.0.0.1:${vitePort}` + req.url);
      const h = Object.fromEntries(r.headers);
      delete h["content-length"];
      // Node fetch already decoded the body; forwarding this header makes
      // Chromium try to decode it again.
      delete h["content-encoding"];
      if (h["content-type"]?.includes("text/html")) {
        const html = (await r.text()).replace(
          "<head>",
          '<head><script src="/__snapshot.js"></script>',
        );
        res.writeHead(r.status, h);
        res.end(html);
      } else {
        res.writeHead(r.status, h);
        res.end(Buffer.from(await r.arrayBuffer()));
      }
    } catch {
      res.writeHead(502);
      res.end("Vite unavailable");
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`snapshot browser at http://127.0.0.1:${port}/`));
