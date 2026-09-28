const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const Database = require('better-sqlite3');
require('dotenv').config();

let pool = null;
let sqliteDb = null;
let activeEngine = 'unknown';

// Ensure data folder exists for SQLite fallback
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const sqlitePath = path.join(dataDir, 'glassbox.db');

function initSqlite() {
  console.log('[Database] Initializing SQLite local engine at:', sqlitePath);
  sqliteDb = new Database(sqlitePath);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');

  // Create SQLite tables matching the PostgreSQL schema
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      auth_provider TEXT DEFAULT 'local',
      google_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS uploaded_datasets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'ready'
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_reset_token ON password_reset_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_datasets_user ON uploaded_datasets(user_id);

    CREATE TABLE IF NOT EXISTS processing_jobs (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dataset_id INTEGER NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'queued',
      config_json TEXT,
      error_message TEXT,
      started_at DATETIME,
      finished_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS processed_datasets (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_dataset_id INTEGER NOT NULL REFERENCES uploaded_datasets(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      rows_before INTEGER,
      rows_after INTEGER,
      columns_before INTEGER,
      columns_after INTEGER,
      date_column TEXT,
      target_column TEXT,
      frequency TEXT,
      quality_score_before REAL,
      quality_score_after REAL,
      readiness_score REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cleaning_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
      step_order INTEGER,
      step_name TEXT,
      column_name TEXT,
      action TEXT,
      method TEXT,
      rows_affected INTEGER,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_processing_jobs_user ON processing_jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_dataset ON processing_jobs(dataset_id);
    CREATE INDEX IF NOT EXISTS idx_processed_datasets_job ON processed_datasets(job_id);
    CREATE INDEX IF NOT EXISTS idx_processed_datasets_user ON processed_datasets(user_id);
    CREATE INDEX IF NOT EXISTS idx_cleaning_actions_job ON cleaning_actions(job_id);
  `);

  activeEngine = 'sqlite';
  console.log('[Database] SQLite connected and tables initialized.');
}

async function initPostgres() {
  const pgConfig = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT || '5433', 10),
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
        database: process.env.PGDATABASE || 'glassbox_bi',
      };

  pool = new Pool(pgConfig);

  // Test connection
  const client = await pool.connect();
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'scripts', 'schema.sql'), 'utf8');
    await client.query(schemaSql);
    activeEngine = 'postgres';
    console.log(`[Database] PostgreSQL connected successfully to ${pgConfig.database || 'database'} on ${pgConfig.host || 'localhost'}. Schema validated.`);
  } finally {
    client.release();
  }
}

async function initializeDatabase() {
  const dbType = (process.env.DB_TYPE || 'auto').toLowerCase();

  if (dbType === 'sqlite') {
    initSqlite();
    return;
  }

  // Attempt Postgres if 'postgres' or 'auto'
  try {
    // Only attempt if password or URL is supplied, or explicitly set to postgres
    if (process.env.PGPASSWORD || process.env.DATABASE_URL || dbType === 'postgres') {
      await initPostgres();
    } else {
      console.log('[Database] No PostgreSQL password configured in .env (PGPASSWORD is empty). Falling back to SQLite.');
      initSqlite();
    }
  } catch (err) {
    if (dbType === 'postgres') {
      console.error('[Database] Failed to connect to requested PostgreSQL instance:', err.message);
      throw err;
    }
    console.warn(`[Database] PostgreSQL connection failed (${err.message}). Gracefully falling back to local SQLite database.`);
    initSqlite();
  }
}

/**
 * Universal Query Adapter
 * Supports $1, $2 query parameters for both PostgreSQL and SQLite
 */
async function query(sql, params = []) {
  if (activeEngine === 'postgres') {
    const result = await pool.query(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount,
      insertId: result.rows && result.rows[0] && result.rows[0].id ? result.rows[0].id : null
    };
  }

  if (activeEngine === 'sqlite') {
    // Convert PostgreSQL $1, $2 parameters to ? for SQLite
    let sqliteSql = sql.replace(/\$(\d+)/g, '?');

    // Handle RETURNING id clause in SQLite
    const hasReturning = /RETURNING\s+([a-zA-Z0-9_,\s*]+)/i.test(sqliteSql);
    const isInsert = /^\s*INSERT/i.test(sqliteSql);
    const isUpdateOrDelete = /^\s*(UPDATE|DELETE)/i.test(sqliteSql);

    // If query has RETURNING in SQLite (supported in modern SQLite 3.35+)
    try {
      const stmt = sqliteDb.prepare(sqliteSql);
      if (isInsert || isUpdateOrDelete) {
        if (hasReturning) {
          const rows = stmt.all(...params);
          return {
            rows: rows,
            rowCount: rows.length,
            insertId: rows[0] && rows[0].id ? rows[0].id : null
          };
        }
        const info = stmt.run(...params);
        return {
          rows: [{ id: info.lastInsertRowid }],
          rowCount: info.changes,
          insertId: info.lastInsertRowid
        };
      } else {
        const rows = stmt.all(...params);
        return {
          rows: rows,
          rowCount: rows.length,
          insertId: null
        };
      }
    } catch (sqliteErr) {
      // Fallback for older SQLite versions if RETURNING is not supported
      if (hasReturning && isInsert) {
        const cleanSql = sqliteSql.replace(/RETURNING\s+[a-zA-Z0-9_,\s*]+/i, '');
        const stmt = sqliteDb.prepare(cleanSql);
        const info = stmt.run(...params);
        return {
          rows: [{ id: info.lastInsertRowid }],
          rowCount: info.changes,
          insertId: info.lastInsertRowid
        };
      }
      throw sqliteErr;
    }
  }

  throw new Error('Database engine is not initialized');
}

function getDbInfo() {
  return {
    engine: activeEngine,
    name: activeEngine === 'postgres' ? (process.env.PGDATABASE || 'glassbox_bi') : 'glassbox.db (SQLite)',
    host: activeEngine === 'postgres' ? (process.env.PGHOST || 'localhost') : 'Local File',
    isPostgres: activeEngine === 'postgres'
  };
}

module.exports = {
  initializeDatabase,
  query,
  getDbInfo
};
