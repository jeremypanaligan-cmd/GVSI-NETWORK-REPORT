#!/usr/bin/env node
/* ------------------------------------------------------------------
   proxy/serve-local.mjs — run the proxy on this machine.

   The worker is a plain `fetch(request) -> Response` function, and Node has all of it
   (Request, Response, fetch, AbortSignal.timeout), so the same code that Cloudflare
   would run can be served locally. That makes the proxy testable and measurable
   BEFORE anything is deployed:

     node proxy/serve-local.mjs --port=8787
     curl -s "http://127.0.0.1:8787/?probe=1"
     curl -s "http://127.0.0.1:8787/?type=nap" -D - -o /dev/null
     node tools/api-probe.js --url="http://127.0.0.1:8787"

   The point of that last line: the probe is the same instrument used for the direct
   baseline, so the two sets of numbers are comparable — one request to one host with
   no redirect, instead of a two-hop chain.

   This is a development harness. The deployed worker is netpulse-proxy.mjs, unchanged.
 * ------------------------------------------------------------------ */

import http from 'node:http';
import { createProxy } from './netpulse-proxy.mjs';

const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(portArg ? portArg.slice('--port='.length) : 8787);

const handle = createProxy();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  try {
    const response = await handle(new Request(url.href, { method: req.method }));
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err && err.message) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('proxy listening on http://127.0.0.1:' + PORT);
  console.log('  try:  curl -s "http://127.0.0.1:' + PORT + '/?probe=1"');
  console.log('  and:  node tools/api-probe.js --url="http://127.0.0.1:' + PORT + '"');
});
