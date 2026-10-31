import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const schema = z.object({
  branch: z.string().min(1).max(500), commit: z.string().regex(/^[a-f0-9]{40}$/),
  pr: z.number().int().positive().optional(), at: z.iso.datetime(),
  local: z.boolean().optional(), release: z.string().max(200).optional(),
}).strict();

export async function deploymentRecord(filename?: string) {
  if (!filename) return null;
  try {
    return schema.parse(JSON.parse(await readFile(filename, 'utf8')));
  } catch { return null; }
}
