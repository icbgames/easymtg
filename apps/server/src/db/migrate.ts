import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client.js';

const { pool, db } = createDatabase();
try {
  const migrationsFolder = fileURLToPath(new URL('../../../../database/migrations', import.meta.url));
  await migrate(db, { migrationsFolder });
} finally {
  await pool.end();
}
