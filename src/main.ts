import { resolve } from 'node:path';
import { Store } from './store.js';
import { seedDemo } from './seed.js';
import { createApp } from './server.js';

const demo = process.argv.includes('--demo');
const filename = resolve(process.env.TERMINOLOGY_DB ?? (demo ? 'data/demo.sqlite' : 'data/terminology.sqlite'));
const port = Number(process.env.PORT ?? 3210);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const store = new Store(filename);
if (demo) seedDemo(store);
const server = createApp(store, { demo, origins: process.env.TERMINOLOGY_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean) });
server.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
server.listen(port, host, () => {
  console.log(`Terminology editor listening on ${host}:${port}`);
  console.log(`Database: ${filename}${demo ? ' (demo)' : ''}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
}
