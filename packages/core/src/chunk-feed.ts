/**
 * Chunk files for a streaming join: fetched ahead of the reader, verified, handed over in order, deleted behind it.
 *
 * A join that first downloads every chunk and then writes the output needs chunks + output on the disk at once. This
 * feed keeps only a window of chunks there:
 *   - several chunks are fetched at the same time (many small objects on keep-alive connections), but never more than
 *     `windowBytes` are on disk; the reader's position always gets its chunk, however large;
 *   - a file is compared with its recorded size and SHA-256 BEFORE the reader is told it is ready (transfer.ts);
 *   - `release(index)` deletes the files of a chunk the reader is done with and lets the next ones in.
 * Files without a URL are already in `dir` (no object storage: the coordinator brought them). They are checked for
 * their size and are not deleted, so a join that fails can be tried again.
 */
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadVerified } from './transfer.ts';
import type { ChunkFeed, FileInfo } from './types.ts';

export type FeedChunk = { index: number; files: (FileInfo & { url?: string })[] };
export type FeedStats = { fetched: number; released: number; bytesFetched: number; diskNow: number; diskPeak: number };

export function createChunkFeed(input: { dir: string; chunks: FeedChunk[]; parallel?: number; windowBytes?: number; signal?: AbortSignal; fetch?: typeof fetch }): ChunkFeed & { stats(): FeedStats; close(): void } {
  const chunks = [...input.chunks].sort((a, b) => a.index - b.index);
  chunks.forEach((chunk, position) => { if (chunk.index !== position) throw new Error(`chunk indexes must be 0..${chunks.length - 1} without gaps (position ${position} has index ${chunk.index})`); });
  const parallel = Math.max(1, input.parallel ?? Number(process.env.RENDER_STITCH_FETCH_PARALLEL ?? 16));
  const windowBytes = Math.max(1, input.windowBytes ?? Number(process.env.RENDER_STITCH_WINDOW_MIB ?? 768) * 1024 * 1024);
  const sizeOf = (chunk: FeedChunk) => chunk.files.reduce((sum, file) => sum + (file.url ? file.bytes : 0), 0);
  const stats: FeedStats = { fetched: 0, released: 0, bytesFetched: 0, diskNow: 0, diskPeak: 0 };
  const abort = new AbortController();
  input.signal?.addEventListener('abort', () => abort.abort(), { once: true });

  const slots = chunks.map(() => { let settle!: { resolve: () => void; reject: (error: unknown) => void }; const promise = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; }); promise.catch(() => undefined); return { promise, ...settle, released: false }; });
  let next = 0; // first chunk not started yet
  let active = 0;
  let windowNow = 0; // bytes of chunks started and not yet released
  let behind = 0; // first chunk not yet released

  async function bring(chunk: FeedChunk) {
    for (const file of chunk.files) {
      const path = join(input.dir, file.name);
      if (!file.url) {
        const size = (await stat(path).catch(() => null))?.size;
        if (size !== file.bytes) throw new Error(`${file.name} is ${size === undefined ? 'missing' : `${size} bytes`}, expected ${file.bytes}`);
        continue;
      }
      await downloadVerified(file.url, path, { bytes: file.bytes, sha256: file.sha256 }, { signal: abort.signal, ...(input.fetch ? { fetch: input.fetch } : {}) });
      stats.bytesFetched += file.bytes;
      stats.diskNow += file.bytes;
      stats.diskPeak = Math.max(stats.diskPeak, stats.diskNow);
    }
  }
  function pump() {
    // The chunk the reader waits for (and the one after it) always starts: the window bounds the read-ahead, not the join.
    while (!abort.signal.aborted && next < chunks.length && active < parallel && (windowNow + sizeOf(chunks[next]!) <= windowBytes || next - behind < 2)) {
      const position = next;
      next += 1;
      active += 1;
      windowNow += sizeOf(chunks[position]!);
      bring(chunks[position]!).then(() => { stats.fetched += 1; slots[position]!.resolve(); }, (error) => { abort.abort(); for (const slot of slots) slot.reject(error); }).finally(() => { active -= 1; pump(); });
    }
  }
  pump();

  return {
    ready: (index) => slots[index]?.promise ?? Promise.reject(new Error(`no chunk ${index}`)),
    async release(index) {
      const slot = slots[index];
      const chunk = chunks[index];
      if (!slot || !chunk || slot.released) return;
      slot.released = true;
      for (const file of chunk.files) if (file.url) { await rm(join(input.dir, file.name), { force: true }); stats.diskNow -= file.bytes; }
      windowNow -= sizeOf(chunk);
      stats.released += 1;
      while (behind < chunks.length && slots[behind]!.released) behind += 1;
      pump();
    },
    stats: () => ({ ...stats }),
    close: () => abort.abort(),
  };
}
