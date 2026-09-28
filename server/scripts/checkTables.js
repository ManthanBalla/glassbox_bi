const { Client } = require('pg');
require('dotenv').config();

async function check() {
  const c = new Client({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5433', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'glassbox_bi'
  });
  await c.connect();
  const res = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
  console.log('PostgreSQL Tables in glassbox_bi:', res.rows.map(r => r.table_name));
  await c.end();
}

check().catch(err => {
  console.error(err);
  process.exit(1);
});
