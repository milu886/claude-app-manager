const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MIRROR = 'https://claudeapp.agentsmirror.com';
const REPO = 'https://github.com/Wangnov/claude-app-mirror';
const API = 'https://api.github.com/repos/Wangnov/claude-app-mirror';
const platforms = {
  'win32-x64': ['windows', 'x64', 'Claude-win-x64.msix', 'win-x64'],
  'win32-arm64': ['windows', 'arm64', 'Claude-win-arm64.msix', 'win-arm64'],
  'darwin-x64': ['macos', 'universal', 'Claude-mac-universal.dmg', 'mac'],
  'darwin-arm64': ['macos', 'universal', 'Claude-mac-universal.dmg', 'mac'],
  'linux-x64': ['linux', 'x64', 'Claude-linux-x64.deb', 'linux-x64'],
  'linux-arm64': ['linux', 'arm64', 'Claude-linux-arm64.deb', 'linux-arm64']
};
function platformInfo(platform = process.platform, arch = process.platform === 'win32' && require('node:os').machine().toLowerCase() === 'arm64' ? 'arm64' : process.arch) {
  const p = platforms[`${platform}-${arch}`];
  if (!p) throw new Error(`不支持的平台：${platform} / ${arch}`);
  return { os: p[0], arch: p[1], assetName: p[2], route: p[3], platform };
}
function compareVersions(a, b) {
  const parse = v => { if (!/^\d+(\.\d+){1,3}$/.test(v)) throw new Error(`无效版本号：${v}`); return v.split('.').map(Number); };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d); }
  return 0;
}
function trustedUrl(raw, { local = false } = {}) {
  const url = new URL(raw);
  if (local && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return url.href;
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('更新源必须使用 HTTPS');
  if (!['claudeapp.agentsmirror.com', 'github.com', 'api.github.com', 'downloads.claude.ai', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new Error(`拒绝未知下载域名：${url.hostname}`);
  return url.href;
}
function officialUrl(raw, version) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'downloads.claude.ai' && !url.search && url.pathname.split('/').includes(version) ? url.href : null;
  } catch { return null; }
}
class ReleaseClient {
  constructor({ mirror = MIRROR, api = API, repo = REPO, local = false, timeout = 18000, fetcher = fetch } = {}) {
    this.mirror = mirror; this.api = api; this.repo = repo; this.local = local; this.timeout = timeout; this.fetcher = fetcher; this.cache = new Map();
  }
  async request(url, { signal, headers = {}, timeout = this.timeout } = {}) {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    for (let i = 0; i < 6; i++) {
      trustedUrl(url, this);
      const response = await this.fetcher(url, { signal: combined, redirect: 'manual', headers: { 'User-Agent': 'Claude-App-Manager/1.0', ...headers } });
      if ([301, 302, 303, 307, 308].includes(response.status)) { const target = response.headers.get('location'); await response.body?.cancel(); if (!target) throw new Error('下载重定向缺少目标'); url = new URL(target, url).href; continue; }
      response.finalUrl = url;
      return response;
    }
    throw new Error('下载重定向次数过多');
  }
  async text(url, signal) {
    const old = this.cache.get(url);
    const r = await this.request(url, { signal, headers: old?.etag ? { 'If-None-Match': old.etag } : {} });
    if (r.status === 304 && old) return old.text;
    if (!r.ok) { await r.body?.cancel(); throw new Error(`更新源 HTTP ${r.status}${r.status === 403 || r.status === 429 ? '，请稍后重试（可能达到请求限制）' : ''}`); }
    let result = ''; const reader = r.body.getReader(); const decoder = new TextDecoder(); let size = 0;
    while (true) { const {done, value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('更新清单过大'); } result += decoder.decode(value, {stream:true}); }
    result += decoder.decode(); this.cache.set(url, { text: result, etag: r.headers.get('etag') }); return result;
  }
  fromManifest(manifest, info, source) {
    const item = manifest?.sources?.[info.os]?.[info.arch];
    if (!item || item.assetName !== info.assetName || !/^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error('清单缺少对应平台或有效 SHA-256');
    compareVersions(item.version, item.version);
    if (!Number.isSafeInteger(item.contentLength) || item.contentLength <= 0 || item.contentLength > 2 ** 33) throw new Error('清单中的安装包大小无效');
    const tag = `claude-app-v${item.version}`, official = officialUrl(item.url, item.version);
    return { version: item.version, sha256: item.sha256.toLowerCase(), size: item.contentLength, assetName: info.assetName,
      publishedAt: manifest.generatedAt, source, releaseUrl: `${this.repo}/releases/tag/${tag}`,
      urls: [`${this.mirror}/latest/${info.route}`, ...(official ? [official] : []), `${this.repo}/releases/download/${tag}/${info.assetName}`] };
  }
  // The GitHub release carries the same manifest entry, including Anthropic's version-pinned CDN URL.
  // Used only when downloading, as one more source for the same verified bytes.
  async officialSource(release, info, signal) {
    const text = await this.text(`${this.repo}/releases/download/claude-app-v${release.version}/release-manifest.json`, signal);
    const item = JSON.parse(text)?.sources?.[info.os]?.[info.arch];
    if (item?.version !== release.version || String(item.sha256).toLowerCase() !== release.sha256 || item.contentLength !== release.size) return null;
    return officialUrl(item.url, release.version);
  }
  async latest(info, preference = 'auto', signal) {
    if (preference === 'github') {
      try { const result = await this.fromGitHub(info, signal); result.urls = result.urls.slice(0, 1); return result; }
      catch (error) { throw new Error(`GitHub：${error.message}`); }
    }
    const [mirror, github] = await Promise.allSettled([
      this.text(`${this.mirror}/latest/manifest`, signal).then(text => this.fromManifest(JSON.parse(text), info, '国内镜像')),
      this.fromGitHub(info, signal)]);
    if (signal?.aborted) throw signal.reason;
    if (mirror.status === 'rejected' && github.status === 'rejected') throw new Error(`镜像：${mirror.reason.message}；GitHub：${github.reason.message}`);
    if (mirror.status === 'rejected') return github.value;
    // The mirror manifest can lag behind GitHub releases. A failed GitHub request (e.g. rate limit) reuses the
    // last GitHub release seen, so the offered version does not flip back and forth between checks.
    const known = github.status === 'fulfilled' ? github.value : this.lastGitHub?.assetName === info.assetName ? { ...this.lastGitHub } : null;
    // The mirror only serves /latest, so a newer GitHub release is downloaded from its version-pinned URLs only.
    if (known && compareVersions(known.version, mirror.value.version) > 0) return { ...known, urls: known.urls.filter(url => !new URL(url).pathname.startsWith('/latest/')) };
    return mirror.value;
  }
  // Each release carries release-manifest.json (same schema as the mirror manifest, with SHA-256 and Anthropic's
  // pinned CDN URL). Fetching it through the "latest" download redirect is a release-asset download, not REST API
  // traffic, so it is not capped at 60 requests/hour per IP — a shared proxy exit IP had used that quota up, and
  // GitHub counts even 304 responses against it. The REST API stays as a fallback for releases without the file.
  async fromGitHub(info, signal) {
    let result;
    try { result = this.fromManifest(JSON.parse(await this.text(`${this.repo}/releases/latest/download/release-manifest.json`, signal)), info, 'GitHub'); }
    catch (error) {
      if (signal?.aborted) throw error;
      try { result = await this.fromGitHubApi(info, signal); }
      catch (apiError) { throw new Error(`${error.message}；API：${apiError.message}`); }
    }
    result.urls.reverse();
    this.lastGitHub = { ...result, urls: [...result.urls] };
    return result;
  }
  async fromGitHubApi(info, signal) {
    const release = JSON.parse(await this.text(`${this.api}/releases/latest`, signal));
    if (release.draft || release.prerelease || !/^claude-app-v\d+(\.\d+){2}$/.test(release.tag_name)) throw new Error('发布版本无效');
    const asset = release.assets?.find(a => a.name === info.assetName);
    if (!asset) throw new Error('该版本没有对应平台安装包');
    const tag = release.tag_name, version = tag.slice('claude-app-v'.length);
    let sha = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1];
    if (!sha) {
      const sums = await this.text(`${this.repo}/releases/download/${tag}/SHA256SUMS.txt`, signal);
      sha = sums.split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i)).find(m => m?.[2] === info.assetName)?.[1];
    }
    return this.fromManifest({generatedAt:release.published_at, sources:{[info.os]:{[info.arch]:{version,sha256:sha,contentLength:asset.size,assetName:asset.name}}}}, info, 'GitHub');
  }
}
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
// Measured on a proxied connection: one connection ~1.7 MB/s from GitHub, eight ~5.4 MB/s. Chunks keep a
// stalled or failing source cheap to retry elsewhere and make an interrupted download resumable.
const CHUNK_SIZE = 8 * 1024 * 1024, CONNECTIONS = 6, STALL_MS = 30000;
class RangeUnsupported extends Error {}
// Aborts a request when no bytes arrive for `ms`; `touch()` on every chunk keeps it alive.
function stallWatch(signal, ms) {
  const idle = new AbortController(); let timer;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error(`连接 ${ms / 1000} 秒没有收到数据`)), ms); timer.unref?.(); };
  touch();
  return { signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal, touch, stop: () => clearTimeout(timer), reason: () => idle.signal.aborted ? idle.signal.reason : null };
}
async function downloadVerified(client, release, dir, { signal, onProgress = () => {}, connections = CONNECTIONS, chunkSize = CHUNK_SIZE, stall = STALL_MS } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  if (!/^Claude-(win-(x64|arm64)\.msix|mac-universal\.dmg|linux-(x64|arm64)\.deb)$/.test(release.assetName)) throw new Error('无效安装包文件名');
  compareVersions(release.version, release.version);
  const file = path.join(dir, `${release.version}-${release.sha256.slice(0,12)}-${release.assetName}`), partial = `${file}.part`;
  if (await fsp.stat(file).then(s => s.size === release.size).catch(() => false)) {
    if (await hashFile(file) === release.sha256) { onProgress({ phase: 'ready', received: release.size, total: release.size, cached: true }); return file; }
  }
  if (connections > 1 && release.size >= 2 * chunkSize) {
    const options = { signal, onProgress, connections, chunkSize, stall };
    try {
      await downloadChunks(client, release, release.urls, partial, options);
      if (await verifyPartial(release, partial, onProgress)) return publish(partial, file, release, onProgress);
      // A mirror "/latest" route can switch versions mid-download; retry once from version-pinned sources only.
      const pinned = release.urls.filter(url => !new URL(url).pathname.startsWith('/latest/'));
      if (pinned.length && pinned.length < release.urls.length) {
        await downloadChunks(client, release, pinned, partial, options);
        if (await verifyPartial(release, partial, onProgress)) return publish(partial, file, release, onProgress);
      }
      throw new Error('SHA-256 校验失败，已拒绝安装；请重新检查更新');
    } catch (error) {
      if (signal?.aborted) { await removePartial(partial); throw error; }
      if (!(error instanceof RangeUnsupported)) throw error;
    }
  }
  const errors = [];
  for (const url of release.urls) {
    if (signal?.aborted) throw signal.reason;
    const watch = stallWatch(signal, stall);
    try {
      onProgress({phase:'downloading', received:0, total:release.size, host:new URL(url).hostname, connections:1});
      const r = await client.request(url, {signal:watch.signal, timeout:30 * 60 * 1000});
      if (!r.ok || !r.body) { await r.body?.cancel(); throw new Error(`下载 HTTP ${r.status}`); }
      const announced = Number(r.headers.get('content-length'));
      if (announced && announced !== release.size) { await r.body.cancel(); throw new Error('安装包已变化，需重新检查更新'); }
      let received = 0, last = 0; const hash = createHash('sha256');
      const counter = new Transform({transform(chunk, enc, cb) {
        watch.touch(); received += chunk.length; if (received > release.size) { cb(new Error('下载文件大于清单大小')); return; }
        hash.update(chunk); const now = Date.now(); if (now - last > 150) { last = now; onProgress({phase:'downloading',received,total:release.size,connections:1}); } cb(null,chunk);
      }});
      await pipeline(Readable.fromWeb(r.body), counter, fs.createWriteStream(partial), { signal: watch.signal });
      onProgress({phase:'verifying', received,total:release.size});
      if (received !== release.size || hash.digest('hex') !== release.sha256) throw new Error('SHA-256 校验失败，已拒绝安装；请重新检查更新');
      await fsp.rename(partial, file);
      onProgress({phase:'ready',received,total:release.size}); return file;
    } catch(error) { await removePartial(partial); if (signal?.aborted) throw error; errors.push(`${new URL(url).hostname}：${watch.reason()?.message || error.message}`); }
    finally { watch.stop(); }
  }
  throw new Error(errors.join('；'));
}
async function removePartial(partial) { await fsp.rm(partial, { force: true }); await fsp.rm(`${partial}.json`, { force: true }); }
async function verifyPartial(release, partial, onProgress) {
  onProgress({ phase: 'verifying', received: release.size, total: release.size });
  if (await hashFile(partial) === release.sha256) return true;
  await removePartial(partial); return false;
}
async function publish(partial, file, release, onProgress) {
  await fsp.rename(partial, file); await fsp.rm(`${partial}.json`, { force: true });
  onProgress({ phase: 'ready', received: release.size, total: release.size }); return file;
}
// Parallel ranged download shared across sources. Faster sources take more chunks; a source that fails
// repeatedly or serves different bytes is dropped. Completed chunks are recorded in `<partial>.json`, so a
// network failure leaves a resumable download; only the final SHA-256 decides whether the file is used.
async function downloadChunks(client, release, urls, partial, { signal, onProgress, connections, chunkSize, stall }) {
  const count = Math.ceil(release.size / chunkSize), length = i => Math.min(chunkSize, release.size - i * chunkSize);
  const statePath = `${partial}.json`, done = new Set();
  try {
    const saved = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    if (saved.sha256 === release.sha256 && saved.size === release.size && saved.chunkSize === chunkSize && (await fsp.stat(partial)).size === release.size)
      for (const i of saved.done) if (Number.isInteger(i) && i >= 0 && i < count) done.add(i);
  } catch {}
  if (!done.size) { await removePartial(partial); const created = await fsp.open(partial, 'w'); await created.truncate(release.size); await created.close(); }
  const handle = await fsp.open(partial, 'r+');
  const sources = urls.map(url => ({ url, host: new URL(url).hostname, active: 0, bytes: 0, ms: 0, failures: 0, off: false, noRange: false }));
  const pending = [...Array(count).keys()].filter(i => !done.has(i)), inflight = new Map(), attempts = new Map(), errors = [];
  let doneBytes = [...done].reduce((sum, i) => sum + length(i), 0), last = 0, saving = Promise.resolve();
  const report = force => {
    const now = Date.now(); if (!force && now - last < 150) return; last = now;
    const active = sources.filter(s => s.active);
    onProgress({ phase: 'downloading', received: doneBytes + [...inflight.values()].reduce((a, b) => a + b, 0), total: release.size,
      connections: active.reduce((a, s) => a + s.active, 0), hosts: active.map(s => s.host) });
  };
  const save = () => { const data = JSON.stringify({ sha256: release.sha256, size: release.size, chunkSize, done: [...done] }); saving = saving.then(() => fsp.writeFile(statePath, data)).catch(() => {}); };
  // Unmeasured sources are tried first so every source gets sampled; afterwards throughput per active connection wins.
  const score = s => (s.ms ? s.bytes / s.ms : 1e9) / (s.active + 1);
  const pick = () => sources.filter(s => !s.off && !s.noRange).sort((a, b) => score(b) - score(a))[0];
  async function fetchChunk(i, source) {
    const start = i * chunkSize, end = start + length(i) - 1, watch = stallWatch(signal, stall), began = Date.now();
    let position = start;
    try {
      const r = await client.request(source.resolved || source.url, { signal: watch.signal, timeout: 10 * 60 * 1000, headers: { Range: `bytes=${start}-${end}` } });
      if (r.status === 200) { await r.body?.cancel(); throw new RangeUnsupported(`${source.host} 不支持分段下载`); }
      if (r.status !== 206 || !r.body) { await r.body?.cancel(); throw new Error(`下载 HTTP ${r.status}`); }
      if (r.headers.get('content-range') !== `bytes ${start}-${end}/${release.size}`) { await r.body.cancel(); source.off = true; throw new Error('安装包已变化，需重新检查更新'); }
      if (r.finalUrl && r.finalUrl !== source.url) source.resolved = r.finalUrl;
      const reader = r.body.getReader();
      for (;;) {
        const { done: finished, value } = await reader.read(); if (finished) break;
        watch.touch(); if (position + value.byteLength > end + 1) { await reader.cancel(); throw new Error('下载分段大于请求范围'); }
        await handle.write(value, 0, value.byteLength, position); position += value.byteLength; inflight.set(i, position - start); report();
      }
      if (position !== end + 1) throw new Error('下载分段不完整');
      source.bytes += length(i); source.ms += Math.max(1, Date.now() - began); source.failures = 0;
    } catch (error) { throw watch.reason() || error; }
    finally { watch.stop(); }
  }
  async function worker() {
    while (pending.length) {
      if (signal?.aborted) throw signal.reason;
      const source = pick(); if (!source) return;
      const i = pending.shift(); source.active++; inflight.set(i, 0);
      try { await fetchChunk(i, source); done.add(i); doneBytes += length(i); save(); }
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        pending.unshift(i); source.resolved = null;
        if (error instanceof RangeUnsupported) source.noRange = true;
        else { errors.push(`${source.host}：${error.message}`); if (++source.failures >= 3) source.off = true; }
        attempts.set(i, (attempts.get(i) || 0) + 1);
        if (attempts.get(i) >= 8) for (const s of sources) s.off = true;
      } finally { source.active--; inflight.delete(i); report(); }
    }
  }
  let results;
  try {
    report(true);
    results = await Promise.allSettled(Array.from({ length: Math.min(connections, pending.length || 1) }, worker));
    await saving;
  } finally { await handle.close(); }
  const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
  if (done.size === count) return;
  if (!done.size && sources.every(s => s.noRange || s.off) && sources.some(s => s.noRange) && !errors.length) { await removePartial(partial); throw new RangeUnsupported('更新源不支持分段下载'); }
  throw new Error(`下载未完成（已保留 ${Math.round(doneBytes / release.size * 100)}%，重试将继续）：${[...new Set(errors)].slice(-3).join('；') || '没有可用的下载源'}`);
}
function updateAvailable(installed, latest) { return Boolean(installed?.version && latest?.version && compareVersions(latest.version,installed.version) > 0); }
module.exports = { MIRROR, REPO, API, ReleaseClient, platformInfo, compareVersions, trustedUrl, hashFile, downloadVerified, updateAvailable };
