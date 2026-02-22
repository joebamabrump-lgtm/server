const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

let dbType = 'sqlite';
let pool;
let sqliteDb;

if (process.env.DATABASE_URL) {
  dbType = 'postgres';
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  console.log('⚠️ DATABASE_URL not found, falling back to local SQLite');
  sqliteDb = new sqlite3.Database('./database.sqlite');

  pool = {
    query: (text, params) => {
      let sql = text.replace(/\$(\d+)/g, '?');
      sql = sql.replace(/NOW\(\)/g, 'CURRENT_TIMESTAMP');

      return new Promise((resolve, reject) => {
        if (sql.trim().toUpperCase().startsWith('SELECT')) {
          sqliteDb.all(sql, params || [], (err, rows) => {
            if (err) reject(err);
            else resolve({ rows });
          });
        } else {
          sqliteDb.run(sql, params || [], function (err) {
            if (err) reject(err);
            else resolve({ rows: [], lastID: this.lastID, changes: this.changes });
          });
        }
      });
    },
    connect: () => ({
      query: (text, params) => pool.query(text, params),
      release: () => { }
    })
  };
}

async function initDb() {
  if (dbType === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS keys (
          id SERIAL PRIMARY KEY,
          key_value TEXT UNIQUE NOT NULL,
          username TEXT, 
          is_admin INTEGER DEFAULT 0,
          is_banned INTEGER DEFAULT 0,
          is_registered INTEGER DEFAULT 0,
          referral_code TEXT UNIQUE,
          referred_by_id INTEGER,
          premium_until TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          expires_at TIMESTAMP,
          last_active_at TIMESTAMP,
          admin_type TEXT DEFAULT 'none',
          last_read_announcement_id INTEGER DEFAULT 0,
          FOREIGN KEY(referred_by_id) REFERENCES keys(id)
        );

        CREATE TABLE IF NOT EXISTS announcements (
          id SERIAL PRIMARY KEY,
          content TEXT NOT NULL,
          author_id INTEGER,
          created_at TIMESTAMP DEFAULT NOW(),
          FOREIGN KEY(author_id) REFERENCES keys(id)
        );

        CREATE TABLE IF NOT EXISTS game_logs (
          id SERIAL PRIMARY KEY,
          user_id INTEGER,
          game_type TEXT,
          mines_count INTEGER,
          prediction TEXT,
          actual_outcome TEXT,
          client_seed TEXT,
          server_seed_hash TEXT,
          nonce INTEGER,
          confidence TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          FOREIGN KEY(user_id) REFERENCES keys(id)
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT
        );

        CREATE TABLE IF NOT EXISTS payment_requests (
          id SERIAL PRIMARY KEY,
          wallet_address TEXT,
          amount REAL,
          coin TEXT,
          status TEXT DEFAULT 'pending',
          tx_hash TEXT UNIQUE,
          email TEXT,
          user_key TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);

      // Migration: Add columns if missing
      await client.query(`
        DO $$ 
        BEGIN 
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keys' AND column_name='admin_type') THEN
            ALTER TABLE keys ADD COLUMN admin_type TEXT DEFAULT 'none';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keys' AND column_name='last_read_announcement_id') THEN
            ALTER TABLE keys ADD COLUMN last_read_announcement_id INTEGER DEFAULT 0;
          END IF;
        END $$;
      `);

      console.log('✅ PostgreSQL database initialized');
    } finally {
      client.release();
    }
  } else {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_value TEXT UNIQUE NOT NULL,
        username TEXT, 
        is_admin INTEGER DEFAULT 0,
        is_banned INTEGER DEFAULT 0,
        is_registered INTEGER DEFAULT 0,
        referral_code TEXT UNIQUE,
        referred_by_id INTEGER,
        premium_until DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        last_active_at DATETIME,
        admin_type TEXT DEFAULT 'none',
        last_read_announcement_id INTEGER DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        author_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration for SQLite
    try {
      await pool.query("ALTER TABLE keys ADD COLUMN admin_type TEXT DEFAULT 'none'");
    } catch (e) { }
    try {
      await pool.query("ALTER TABLE keys ADD COLUMN last_read_announcement_id INTEGER DEFAULT 0");
    } catch (e) { }

    console.log('✅ SQLite database ready');
  }

  // --- SEED ADMINS ---
  const adminKeyNiam = 'admin-niam';
  const checkNiam = await pool.query('SELECT id FROM keys WHERE key_value = $1', [adminKeyNiam]);
  if (checkNiam.rows.length === 0) {
    const refCode = 'NIAM-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    await pool.query(
      "INSERT INTO keys (key_value, username, is_admin, is_registered, referral_code, admin_type) VALUES ($1, 'AdminBoss', 1, 1, $2, 'full')",
      [adminKeyNiam, refCode]
    );
  } else {
    await pool.query("UPDATE keys SET admin_type = 'full' WHERE key_value = $1", [adminKeyNiam]);
  }

  const adminKeyBlazee = 'admin-blazee';
  const checkBlazee = await pool.query('SELECT id FROM keys WHERE key_value = $1', [adminKeyBlazee]);
  if (checkBlazee.rows.length === 0) {
    const refCode = 'BLZE-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    await pool.query(
      "INSERT INTO keys (key_value, username, is_admin, is_registered, referral_code, admin_type) VALUES ($1, 'KeyForge', 1, 1, $2, 'keygen')",
      [adminKeyBlazee, refCode]
    );
  } else {
    await pool.query("UPDATE keys SET admin_type = 'keygen' WHERE key_value = $1", [adminKeyBlazee]);
  }

  const keysWithoutRef = await pool.query('SELECT id FROM keys WHERE referral_code IS NULL');
  for (const k of keysWithoutRef.rows) {
    const code = 'REF-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    await pool.query('UPDATE keys SET referral_code = $1 WHERE id = $2', [code, k.id]);
  }
}

module.exports = { pool, initDb };
