#!/usr/bin/env node
/**
 * Takes the scripts a HyperFrames project loads from a CDN (GSAP and the like) into the project, so every instance
 * renders with the same bytes and needs no network for them (the determinism pre-flight flags network scripts).
 *
 *   node vendor-scripts.mjs <project dir> --rewrite   once: download every <script src="https://...">, save it under
 *                                                     assets/vendor/, point index.html at the copy, and write
 *                                                     vendor.lock.json (URL and SHA-256 of each file)
 *   node vendor-scripts.mjs <project dir>             every build: fetch what vendor.lock.json lists and is missing,
 *                                                     and refuse a file whose SHA-256 differs
 *
 * Commit index.html and vendor.lock.json; leave assets/vendor/ out of git (it is fetched again from the lock). Check
 * the licence of what you vendor (GSAP: https://gsap.com/standard-license).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [projectArg, flag] = process.argv.slice(2);
if (!projectArg) { console.error('usage: vendor-scripts.mjs <project dir> [--rewrite]'); process.exit(2); }
const project = resolve(projectArg);
const lockPath = join(project, 'vendor.lock.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

if (flag === '--rewrite') {
  const htmlPath = join(project, 'index.html');
  let html = readFileSync(htmlPath, 'utf8');
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { files: [] };
  for (const match of [...html.matchAll(/<script\b([^>]*?)\bsrc\s*=\s*(["'])((?:https?:)?\/\/[^"']+)\2([^>]*)>/gi)]) {
    const url = match[3].startsWith('//') ? `https:${match[3]}` : match[3];
    const bytes = await download(url);
    const file = `assets/vendor/${basename(new URL(url).pathname)}`;
    mkdirSync(join(project, 'assets/vendor'), { recursive: true });
    writeFileSync(join(project, file), bytes);
    lock.files = lock.files.filter((entry) => entry.file !== file).concat({ file, url, sha256: sha256(bytes) });
    // integrity and crossorigin belong to the CDN copy; the local file is checked by the lock instead.
    const attributes = `${match[1]}${match[4]}`.replace(/\s*(integrity|crossorigin)\s*=\s*(["'])[^"']*\2/gi, '');
    html = html.replace(match[0], `<script${attributes} src="${file}">`.replace(/<script\s+/, '<script '));
    console.log(`${url} -> ${file}`);
  }
  writeFileSync(htmlPath, html);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
} else {
  if (!existsSync(lockPath)) process.exit(0);
  for (const entry of JSON.parse(readFileSync(lockPath, 'utf8')).files) {
    const path = join(project, entry.file);
    if (existsSync(path) && sha256(readFileSync(path)) === entry.sha256) continue;
    const bytes = await download(entry.url);
    if (sha256(bytes) !== entry.sha256) throw new Error(`${entry.url}: SHA-256 differs from vendor.lock.json; the CDN served other bytes`);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
    console.log(`${entry.file}: fetched`);
  }
}
