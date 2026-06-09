require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("Migration эхэллээ...");

    // points column нэмэх
    await client.query(`
      ALTER TABLE players 
      ADD COLUMN IF NOT EXISTS points BIGINT DEFAULT 0
    `);
    console.log("✅ points column нэмэгдлээ");

    // referral_code column нэмэх
    await client.query(`
      ALTER TABLE players 
      ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE
    `);
    console.log("✅ referral_code column нэмэгдлээ");

    // referred_by column нэмэх
    await client.query(`
      ALTER TABLE players 
      ADD COLUMN IF NOT EXISTS referred_by TEXT
    `);
    console.log("✅ referred_by column нэмэгдлээ");

    // last_login_bonus column нэмэх
    await client.query(`
      ALTER TABLE players 
      ADD COLUMN IF NOT EXISTS last_login_bonus DATE
    `);
    console.log("✅ last_login_bonus column нэмэгдлээ");

    // transactions table үүсгэх
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        type TEXT NOT NULL,
        amount BIGINT NOT NULL,
        balance_after BIGINT NOT NULL,
        description TEXT,
        related_username TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ transactions table бэлэн");

    // escrow table үүсгэх
    await client.query(`
      CREATE TABLE IF NOT EXISTS escrow (
        id SERIAL PRIMARY KEY,
        room_id TEXT UNIQUE NOT NULL,
        white_username TEXT NOT NULL,
        black_username TEXT NOT NULL,
        white_bet BIGINT DEFAULT 0,
        black_bet BIGINT DEFAULT 0,
        total BIGINT DEFAULT 0,
        status TEXT DEFAULT 'pending',
        winner TEXT,
        platform_fee BIGINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ escrow table бэлэн");

    // game_history table үүсгэх
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_history (
        id SERIAL PRIMARY KEY,
        white_username TEXT NOT NULL,
        black_username TEXT NOT NULL,
        white_rating_before INTEGER,
        black_rating_before INTEGER,
        white_rating_after INTEGER,
        black_rating_after INTEGER,
        white_points_change BIGINT DEFAULT 0,
        black_points_change BIGINT DEFAULT 0,
        result TEXT NOT NULL,
        moves INTEGER DEFAULT 0,
        time_limit INTEGER,
        played_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ game_history table бэлэн");

    console.log("\n🎉 Migration амжилттай дууслаа!");
  } catch (e) {
    console.error("❌ Migration алдаа:", e.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

migrate();