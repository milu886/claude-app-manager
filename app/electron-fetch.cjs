const { Readable } = require('node:stream');
// Node's fetch ignores the Windows system proxy, so github.com can be unreachable even when the browser works.
// Electron's net stack follows the system proxy. net.fetch cannot return a manual redirect, so redirects are
// surfaced here as 3xx responses and core.cjs keeps validating every hop against its host allowlist.
function electronFetch(net) {
  return (url, { signal, headers = {} } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const request = net.request({ url, method: 'GET', redirect: 'manual', cache: 'no-store', credentials: 'omit', useSessionCookies: false });
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    let message = null;
    const abort = () => { request.abort(); if (message) message.destroy(signal.reason); else reject(signal.reason); };
    const done = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    request.on('redirect', (status, method, location) => { done(); request.abort(); resolve(new Response(null, { status, headers: { location } })); });
    request.on('response', response => {
      message = response; response.on('end', done); response.on('error', done);
      const result = new Headers();
      for (const [name, value] of Object.entries(response.headers)) for (const item of [].concat(value)) result.append(name, item);
      const empty = [204, 205, 304].includes(response.statusCode);
      resolve(new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode, statusText: response.statusMessage, headers: result }));
      if (empty) response.resume();
    });
    request.on('error', error => { done(); reject(error); });
    request.end();
  });
}
module.exports = { electronFetch };
