import {getMigrations} from 'better-auth/db/migration';
import {getMcpAuth} from './runtime';
// Explicit operator action for local SQLite only. Postgres uses db/migrations.
if(process.env.DATABASE_URL)throw new Error('Use the regular Postgres migration command for hosted persistence.');
const server=getMcpAuth();await (await getMigrations(server.options)).runMigrations();
console.log('Local MCP authentication tables are ready.');
