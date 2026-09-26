#!/usr/bin/env node
import { main } from '../src/cli/index.ts';
// The POSIX wrapper owns no-argument/start exec; other commands enter this CLI.
await main(process.argv.slice(2));
