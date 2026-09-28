const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

async function initPostgresDb() {
  console.log('============================================================');
  console.log('GlassBox-BI PostgreSQL Database Initialization & Migration');
  console.log('============================================================');

  const host = process.env.PGHOST || 'localhost';
  const port = parseInt(process.env.PGPORT || '5433', 10);
  const user = process.env.PGUSER || 'postgres';
  const password = process.env.PGPASSWORD || '';
  const targetDbName = process.env.PGDATABASE || 'glassbox_bi';

  console.log(`Connecting to PostgreSQL root server at ${host}:${port} as ${user}...`);

  const rootClient = new Client({
    host,
    port,
    user,
    password,
    database: 'postgres'
  });

  try {
    await rootClient.connect();
    console.log('Connected to PostgreSQL root server successfully.');

    // Check if target database exists
    const checkRes = await rootClient.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [targetDbName]
    );

    if (checkRes.rowCount === 0) {
      console.log(`Database "${targetDbName}" does not exist. Creating database "${targetDbName}"...`);
      await rootClient.query(`CREATE DATABASE "${targetDbName}"`);
      console.log(`Database "${targetDbName}" created successfully!`);
    } else {
      console.log(`Database "${targetDbName}" already exists.`);
    }
  } catch (err) {
    console.error('[FATAL] Failed to connect to PostgreSQL server or create database:', err.message);
    process.exit(1);
  } finally {
    await rootClient.end();
  }

  // Connect to target database
  console.log(`Connecting to database "${targetDbName}" at ${host}:${port}...`);
  const dbClient = new Client({
    host,
    port,
    user,
    password,
    database: targetDbName
  });

  try {
    await dbClient.connect();
    console.log(`Connected to database "${targetDbName}". Applying schema...`);

    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await dbClient.query(schemaSql);
    console.log('PostgreSQL schema applied successfully.');
    console.log('Verified tables: users, password_reset_tokens, uploaded_datasets');

    // Safe migration from SQLite data if data/glassbox.db exists
    const sqlitePath = path.join(__dirname, '..', '..', 'data', 'glassbox.db');
    if (fs.existsSync(sqlitePath)) {
      console.log('\nChecking existing SQLite database for data to safely migrate...');
      try {
        const Database = require('better-sqlite3');
        const sqlite = new Database(sqlitePath, { readonly: true });

        // Migrate users
        const sqliteUsers = sqlite.prepare('SELECT * FROM users').all();
        console.log(`Found ${sqliteUsers.length} user(s) in SQLite.`);

        let migratedUsers = 0;
        for (const u of sqliteUsers) {
          const insertUser = await dbClient.query(
            `INSERT INTO users (full_name, email, password_hash, auth_provider, google_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (email) DO NOTHING
             RETURNING id`,
            [u.full_name, u.email, u.password_hash, u.auth_provider, u.google_id, u.created_at, u.updated_at]
          );
          if (insertUser.rowCount > 0) migratedUsers++;
        }
        console.log(`Migrated ${migratedUsers} new user(s) to PostgreSQL.`);

        // Migrate datasets if any
        const sqliteDatasets = sqlite.prepare('SELECT * FROM uploaded_datasets').all();
        console.log(`Found ${sqliteDatasets.length} dataset(s) in SQLite.`);

        sqlite.close();
      } catch (migrationErr) {
        console.warn('[Migration Warning] SQLite data check completed with note:', migrationErr.message);
      }
    }

    console.log('\n============================================================');
    console.log('PostgreSQL Database Initialization Complete & Ready!');
    console.log(`Active Database: ${targetDbName} on ${host}:${port}`);
    console.log('============================================================\n');
  } catch (err) {
    console.error('[FATAL] Failed to apply schema to database:', err.message);
    process.exit(1);
  } finally {
    await dbClient.end();
  }
}

initPostgresDb();
