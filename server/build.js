import { cp, lstat, mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { publicEntries } from './public-files.js';

const out = 'dist';
await rm(out, { recursive: true, force: true });
await mkdir(out);
for (const entry of publicEntries) {
  await cp(entry, join(out, entry), {
    recursive: true,
    filter: async source => !basename(source).startsWith('.') && !(await lstat(source)).isSymbolicLink()
  });
}
