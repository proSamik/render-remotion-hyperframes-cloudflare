/**
 * Joins the same Remotion chunks three ways and compares the results:
 *   combineChunks()                       the reference
 *   streaming join, MP4                   must be the same file, byte for byte
 *   streaming join, fragmented MP4        must have the same video and audio packets
 * The streaming joins run with one audio file per run of the concat demuxer, the hardest case for "the result does not
 * depend on the batches".
 *
 *   node packages/core/bin/with-typescript-run.mjs packages/cloudflare-containers/scripts/compare-joins.ts <work dir> --fps 30 --frames-per-chunk 30 --frames 90
 * <work dir>: what a local render leaves with --keep-work. The folder with the most chunk files is used.
 * Needs REMOTION_PROJECT_DIR (a folder with @remotion/renderer installed; default: the current folder) and ffmpeg on the PATH.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { streamingStitch } from '../container/streaming-stitch.ts';

const [root, ...rest] = process.argv.slice(3);
const flag = (name: string) => Number(rest[rest.indexOf(`--${name}`) + 1]);
const fps = flag('fps');
const framesPerChunk = flag('frames-per-chunk');
const frames = flag('frames');
if (!root || !fps || !framesPerChunk || !frames) { console.error('Usage: compare-joins.ts <work dir> --fps N --frames-per-chunk N --frames N'); process.exit(2); }

// The folder that holds the chunks: the instance that joined them.
const folders: string[] = [];
const walk = (dir: string) => { for (const entry of readdirSync(dir)) { const path = join(dir, entry); if (statSync(path).isDirectory()) { folders.push(path); walk(path); } } };
walk(resolve(root));
const chunkFiles = (dir: string) => readdirSync(dir).filter((name) => /^chunk-\d{4}-r\d+\.ts$/.test(name));
const dir = folders.sort((a, b) => chunkFiles(b).length - chunkFiles(a).length)[0];
if (!dir || !chunkFiles(dir).length) { console.error(`no chunk files under ${root}`); process.exit(2); }
// One run per chunk: the latest whose two files are there.
const byIndex = new Map<number, string>();
for (const name of chunkFiles(dir).sort()) byIndex.set(Number(name.slice(6, 10)), name.replace(/\.ts$/, ''));
const chunks = [...byIndex].sort((a, b) => a[0] - b[0]).map(([, base]) => ({ video: `${base}.ts`, audio: `${base}.aac` }));

const projectRequire = createRequire(join(resolve(process.env.REMOTION_PROJECT_DIR ?? process.cwd()), 'package.json'));
const renderer = projectRequire('@remotion/renderer');
const version = projectRequire('@remotion/renderer/package.json').version as string;
const binary = renderer.RenderInternals.getExecutablePath({ type: 'ffmpeg', indent: false, logLevel: 'error', binariesDirectory: null }) as string;
const ffmpeg = (args: string[], stdio: import('node:child_process').StdioOptions) => spawn(binary, args, { cwd: dirname(binary), stdio, env: process.platform === 'darwin' ? { ...process.env, DYLD_LIBRARY_PATH: dirname(binary) } : process.env });

await renderer.combineChunks({ outputLocation: join(dir, 'compare-combine.mp4'), videoFiles: chunks.map((chunk) => join(dir, chunk.video)), audioFiles: chunks.map((chunk) => join(dir, chunk.audio)), codec: 'h264', audioCodec: 'aac', fps, framesPerChunk, compositionDurationInFrames: frames, frameRange: null, preferLossless: false, logLevel: 'error' });
const feed = { ready: async () => undefined, release: async () => undefined };
const shared = { ffmpeg, dir, chunks, feed, fps, framesPerChunk, frames, comment: `comment=Made with Remotion ${version}`, audioBatch: 1 };
await streamingStitch({ ...shared, mode: 'mp4', outputName: 'compare-stream.mp4' });
await streamingStitch({ ...shared, mode: 'fmp4', outputName: 'compare-fmp4.mp4' });

const packets = (name: string, stream: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, name), '-map', `0:${stream}`, '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' }).trim();
const describe = (name: string) => ({ name, bytes: statSync(join(dir, name)).size, sha256: createHash('sha256').update(readFileSync(join(dir, name))).digest('hex'), video: packets(name, 'v'), audio: packets(name, 'a') });
const [combine, stream, fragmented] = ['compare-combine.mp4', 'compare-stream.mp4', 'compare-fmp4.mp4'].map(describe) as [ReturnType<typeof describe>, ReturnType<typeof describe>, ReturnType<typeof describe>];
const problems: string[] = [];
if (stream.sha256 !== combine.sha256) problems.push('the streamed MP4 is not the file combineChunks() writes');
if (fragmented.video !== combine.video || fragmented.audio !== combine.audio) problems.push('the fragmented MP4 does not have the packets of the combineChunks() file');
console.log(JSON.stringify({ chunks: chunks.length, remotion: version, files: [combine, stream, fragmented], ok: problems.length === 0, problems }, null, 2));
process.exit(problems.length ? 1 : 0);
