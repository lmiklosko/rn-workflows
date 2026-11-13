import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configSchema } from '../src/config/schema.js';

const out = path.resolve(import.meta.dirname, '../schema/rn-workflows.schema.json');
const schema = {
  title: 'rn-workflows configuration',
  ...z.toJSONSchema(configSchema, { io: 'input' }),
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(schema, null, 2) + '\n');
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
