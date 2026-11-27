#!/usr/bin/env node
import { ensureTypeScript } from '../../core/bin/with-typescript.mjs';

ensureTypeScript();
const { main } = await import('../src/cli/index.ts');
await main(process.argv.slice(2));
