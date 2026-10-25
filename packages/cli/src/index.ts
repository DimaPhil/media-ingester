#!/usr/bin/env node
import { createProgram } from './cli.js';

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Command failed'}\n`);
  process.exitCode = 1;
}
