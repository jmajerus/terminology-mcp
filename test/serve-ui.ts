import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

const directory = mkdtempSync(join(tmpdir(), 'terminology-browser-'));
const store = new Store(join(directory, 'test.sqlite'));
const server = createApp(store);
server.listen(3211, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  }));
}
