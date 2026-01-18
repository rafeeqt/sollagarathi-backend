import express from "express";
import cors from "cors";
import pkg from "pg";
import fetch from "node-fetch";
import dns from "dns";

// Force Node.js to prefer IPv4 over IPv6
dns.setDefaultResultOrder("ipv4first");

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// Debug
console.log("DATABASE_URL =", process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4
});

// Ensure tables exist
async function initDB() {
  try {
    await pool.query(`
      create table if not exists search_history (
        id serial primary key,
        tamil_word text,
        searched_at timestamp default now()
      );
    `);

    await pool.query(`
      create table if not exists words (
        id serial primary key,
        tamil_word text unique,
        created_at timestamp default now()
      );
    `);

    console.log("Database tables ensured");
  } catch (e) {
    console.error("DB INIT ERROR:", e.message);
  }
}

initDB();

app.get("/", (req, res) => {
  res.send("Sollagarathi Backend Running");
});

// Word of the Day
app.get("/word-of-the-day", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT tamil_word 
       FROM search_history 
       GROUP BY tamil_word 
       ORDER BY COUNT(*) DESC 
       LIMIT 1`
    );
    res.json(r.rows[0] || {});
  } catch {
    res.json({});
  }
});

// Multi-source Search (collect ALL results)
app.get("/search/:word", async (req, res) => {
  const { word } = req.params;
  const results = [];

  try {
    await pool.query(
      "INSERT INTO search_history(tamil_word) VALUES($1)",
      [word]
    );

    // 1️⃣ Local DB
    try {
      const local = await pool.query(
        "SELECT * FROM words WHERE tamil_word=$1",
        [word]
      );
      if (local.rows.length > 0) {
        results.push({
          source: "local",
          text: `உள்ளூர் தரவுத்தளத்தில் "${word}" உள்ளது.`
        });
      }
    } catch {}

    // 2️⃣ Wiktionary
    try {
      const wikiUrl =
        "https://ta.wiktionary.org/w/api.php" +
        "?action=query&format=json&origin=*" +
        "&prop=extracts&explaintext=1&titles=" +
        encodeURIComponent(word);

      const r = await fetch(wikiUrl);
      const j = await r.json();
      const pages = j.query.pages;
      const page = pages[Object.keys(pages)[0]];

      if (page && page.extract) {
        await pool.query(
          "INSERT INTO words(tamil_word) VALUES($1) ON CONFLICT DO NOTHING",
          [word]
        );

        results.push({
          source: "wiktionary",
          text: page.extract
        });
      }
    } catch {}

    // 3️⃣ Agarathi
    try {
      const agarathiUrl =
        "https://www.agarathi.com/word/" + encodeURIComponent(word);

      const r2 = await fetch(agarathiUrl);
      const html = await r2.text();

      if (html && html.length > 500) {
        await pool.query(
          "INSERT INTO words(tamil_word) VALUES($1) ON CONFLICT DO NOTHING",
          [word]
        );

        results.push({
          source: "agarathi",
          text:
            "இந்த சொல் Agarathi.com-இல் கிடைக்கிறது. முழு விளக்கத்தை அங்கு பார்க்கவும்:\n" +
            agarathiUrl
        });
      }
    } catch {}

    // 4️⃣ Thanithamizh
    try {
      const tUrl =
        "https://thanithamizhakarathikalanjiyam.github.io/?q=" +
        encodeURIComponent(word);

      const r3 = await fetch(tUrl);
      const html2 = await r3.text();

      if (html2 && html2.length > 500) {
        await pool.query(
          "INSERT INTO words(tamil_word) VALUES($1) ON CONFLICT DO NOTHING",
          [word]
        );

        results.push({
          source: "thanithamizh",
          text:
            "இந்த சொல் ‘தனித்தமிழ் அகராதி களஞ்சியம்’ தளத்தில் கிடைக்கிறது. முழு விளக்கத்தை அங்கு பார்க்கவும்:\n" +
            tUrl
        });
      }
    } catch {}

    // 5️⃣ DSAL
    try {
      const dsalUrl =
        "https://dsal.uchicago.edu/cgi-bin/app/tamil-lexicon_query.py?qs=" +
        encodeURIComponent(word);

      const r4 = await fetch(dsalUrl);
      const html3 = await r4.text();

      if (html3 && html3.length > 1000) {
        await pool.query(
          "INSERT INTO words(tamil_word) VALUES($1) ON CONFLICT DO NOTHING",
          [word]
        );

        results.push({
          source: "dsal",
          text:
            "இந்த சொல் University of Chicago – DSAL அகராதிகளில் கிடைக்கிறது. முழு விளக்கத்தை அங்கு பார்க்கவும்:\n" +
            dsalUrl
        });
      }
    } catch {}

    return res.json({ results });
  } catch (e) {
    console.error("SEARCH ERROR:", e.message);
    return res.status(500).json({
      results: [],
      error: "Internal error"
    });
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server started")
);
