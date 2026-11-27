#!/usr/bin/env node
// Runs a TypeScript file with the same fallback as the command line tools: node with-typescript-run.mjs <file.ts> [args]
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureTypeScript } from './with-typescript.mjs';

ensureTypeScript();
await import(pathToFileURL(resolve(process.argv[2])).href);
