#!/usr/bin/env node
import { ensureTypeScript } from './with-typescript.mjs';

ensureTypeScript();
const { main } = await import('../src/cli.ts');
await main(process.argv.slice(2));
