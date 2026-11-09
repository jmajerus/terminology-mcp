import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from './store.js';

const usage = `Usage: node dist/cli.js delete <scheme-id> [--db <file>] [--yes]
       node dist/cli.js rename <scheme-id> "New name" [--db <file>] [--yes]

Previews deletion of a scheme, its terms and concept sets. Pass --yes to apply.
Renames change the display name and preserve the scheme ID.
Both commands preview by default; pass --yes to apply.
History is retained; deleted scheme IDs remain reserved.
Database: --db, TERMINOLOGY_DB, or data/terminology.sqlite.
Run on the machine hosting the database.`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: { db: { type: 'string' }, yes: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) console.log(usage);
  else {
    const [command, id, label] = positionals;
    if (!((command === 'delete' && positionals.length === 2) || (command === 'rename' && positionals.length === 3)))
      throw new Error(usage);
    const filename = resolve(values.db ?? process.env.TERMINOLOGY_DB ?? 'data/terminology.sqlite');
    if (!existsSync(filename)) throw new Error(`Database does not exist: ${filename}`);
    const store = new Store(filename);
    try {
      const version = store.version;
      const apply = () => {
        if (command === 'delete') return store.deleteScheme(id, version);
        const scheme = store.updateScheme(id, { label, expectedVersion: version });
        return { version: store.version, scheme };
      };
      const result = values.yes ? apply() : store.preview(apply);
      console.log(JSON.stringify({ applied: !!values.yes, database: filename, ...result }, null, 2));
      if (!values.yes) console.log(`Preview only. Pass --yes to apply ${command === 'rename' ? 'rename' : 'deletion'}.`);
    } finally { store.close(); }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
