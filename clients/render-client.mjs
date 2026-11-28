/**
 * A tiny client for the render service's HTTP API (docs/api.md). No dependencies; Node 18+ or any runtime with
 * fetch. Copy this file into your project.
 *
 *   import { RenderClient } from './render-client.mjs';
 *   const client = new RenderClient(process.env.RENDER_SERVICE_URL, process.env.RENDER_SECRET);
 *   const { url } = await client.upload('photo.jpg', await readFile('photo.jpg'), 'image/jpeg');
 *   const { renderId } = await client.render({ engine: 'remotion', composition: 'Shapes', inputProps: { title: 'Hi' }, quality: '720p', tier: 'standard' });
 *   const done = await client.wait(renderId, (p) => console.log(p.percent, p.phase));
 *   const link = await client.downloadUrl(renderId);      // works without the secret, for an hour
 *   await client.download(renderId, 'video.mp4');         // Node only; checks the SHA-256
 *   await client.delete(renderId);
 *
 * Never put the secret into a web page: anyone who has it can render on your account.
 */
export class RenderClient {
  /** @param {string} serviceUrl  https://<name>.<subdomain>.workers.dev  @param {string} secret  RENDER_SECRET */
  constructor(serviceUrl, secret) {
    if (!serviceUrl || !secret) throw new Error('RenderClient needs the service URL and the secret');
    this.serviceUrl = serviceUrl.replace(/\/+$/, '');
    this.secret = secret;
  }

  async #call(path, init = {}) {
    const response = await fetch(`${this.serviceUrl}${path}`, { ...init, headers: { authorization: `Bearer ${this.secret}`, ...init.headers } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text.slice(0, 500)}`);
    return JSON.parse(text);
  }

  /** { ok, service, storage, instanceType, maxInstancesPerRender } */
  health() { return this.#call('/health'); }

  /**
   * Stores an input file (image, video, audio, JSON) in R2, up to 100 MB. Answers { uploadId, name, bytes, url }: pass
   * `url` to your composition in inputProps or variables; it works for 7 days without the secret.
   */
  upload(name, body, contentType = 'application/octet-stream') {
    return this.#call(`/uploads/${encodeURIComponent(name)}`, { method: 'PUT', body, headers: { 'content-type': contentType } });
  }
  deleteUpload(uploadId) { return this.#call(`/uploads/${uploadId}`, { method: 'DELETE' }); }

  /**
   * Starts a render. Short form: { engine: 'remotion' | 'hyperframes' | 'mixed', composition, inputProps | variables,
   * range: [first, last], quality: '480p' ... '4k', tier: 'economy' | 'standard' | 'fast' }. The full form
   * { render, fleet } works too. Answers { renderId }.
   */
  render(request) {
    return this.#call('/renders', { method: 'POST', body: JSON.stringify(request), headers: { 'content-type': 'application/json' } });
  }

  /** { done, percent, phase: planning | rendering | stitching | done | failed, framesRendered, frames, errors, costs, ... } */
  progress(renderId) { return this.#call(`/renders/${renderId}`); }

  /** Polls until done. Throws with the errors when the render failed. */
  async wait(renderId, onProgress, pollMs = 2000) {
    for (;;) {
      const progress = await this.progress(renderId);
      onProgress?.(progress);
      if (progress.done) return progress;
      if (progress.fatalErrorEncountered) throw new Error(`render ${renderId} failed: ${progress.errors.filter((error) => error.fatal).map((error) => error.message).join('; ')}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** A link to the finished file that needs no secret, valid for `seconds` (60 s to 7 days). */
  async downloadUrl(renderId, seconds = 3600) { return (await this.#call(`/renders/${renderId}/link?expires=${seconds}`)).url; }

  /** Node only: streams the file to `path` and compares its SHA-256 with the one the service reported. */
  async download(renderId, path) {
    const [{ createWriteStream }, { createHash }, { Readable }, { pipeline }] = await Promise.all([import('node:fs'), import('node:crypto'), import('node:stream'), import('node:stream/promises')]);
    const expected = (await this.progress(renderId)).outputSha256;
    const response = await fetch(await this.downloadUrl(renderId));
    if (!response.ok || !response.body) throw new Error(`download: ${response.status}`);
    const hash = createHash('sha256');
    const body = Readable.fromWeb(response.body);
    body.on('data', (chunk) => hash.update(chunk));
    await pipeline(body, createWriteStream(path));
    if (expected && hash.digest('hex') !== expected) throw new Error('the download arrived damaged (SHA-256 differs)');
    return path;
  }

  /** Stops the render and its instances; the progress stays readable. */
  cancel(renderId) { return this.#call(`/renders/${renderId}/cancel`, { method: 'POST' }); }
  /** Stops it if needed and deletes its files. Do this when you have the video. */
  delete(renderId) { return this.#call(`/renders/${renderId}`, { method: 'DELETE' }); }
}
