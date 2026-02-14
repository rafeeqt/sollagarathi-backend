import express from "express";
import cors from "cors";
import pkg from "pg";
import fetch from "node-fetch";
import dns from "dns";

// Force Node.js to prefer IPv4 for Supabase stability
dns.setDefaultResultOrder("ipv4first");

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4
});

// --- 1. Database Initialization ---
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS search_history (
        id SERIAL PRIMARY KEY,
        tamil_word TEXT,
        searched_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS master_entries (
        id SERIAL PRIMARY KEY,
        lemma TEXT UNIQUE,
        entry TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Database Tables Verified");
  } catch (e) {
    console.error("❌ DB INIT ERROR:", e.message);
  }
}
initDB();

// --- 2. SEO: Dynamic Sitemap.xml ---
// This allows Google to find all 10,000+ words automatically
app.get("/sitemap.xml", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT lemma FROM master_entries LIMIT 15000");
    res.header('Content-Type', 'application/xml');

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://sollagarathi.com/</loc><priority>1.0</priority></url>`;

    rows.forEach(row => {
      xml += `
  <url>
    <loc>https://sollagarathi.com/word/${encodeURIComponent(row.lemma)}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
    });

    xml += `\n</urlset>`;
    res.send(xml);
  } catch (err) {
    res.status(500).end();
  }
});

// --- 3. Optimized Search Waterfall ---
// Priority: 1. Local Word Bank (SEO) -> 2. Wiktionary -> 3. DSAL (Chicago)
app.get("/api/word/:word", async (req, res) => {
  const { word } = req.params;
  const wordData = { lemma: word, results: [] };

  try {
    // Log search history
    await pool.query("INSERT INTO search_history(tamil_word) VALUES($1)", [word]);

    // Check Local Supabase "Word Bank"
    const local = await pool.query("SELECT entry FROM master_entries WHERE lemma = $1", [word]);
    if (local.rows.length > 0) {
      wordData.results.push({ source: "Sollagarathi Master", text: local.rows[0].entry });
    }

    // Fetch from Wiktionary (Real-time fallback)
    try {
      const wikiRes = await fetch(`https://ta.wiktionary.org/w/api.php?action=query&format=json&prop=extracts&explaintext=1&titles=${encodeURIComponent(word)}`);
      const wikiJson = await wikiRes.json();
      const page = wikiJson.query.pages[Object.keys(wikiJson.query.pages)[0]];
      if (page && page.extract) {
        wordData.results.push({ source: "Wiktionary", text: page.extract });
      }
    } catch (e) {}

    // Fetch from DSAL University of Chicago
    try {
      const dsalUrl = `https://dsal.uchicago.edu/cgi-bin/app/tamil-lexicon_query.py?qs=${encodeURIComponent(word)}`;
      wordData.results.push({ source: "University of Madras Lexicon (DSAL)", url: dsalUrl, type: "link" });
    } catch (e) {}

    res.json(wordData);
  } catch (err) {
    res.status(500).json({ error: "Search failed" });
  }
});

// --- 4. Google Transliteration (Keeping your working logic) ---
app.post("/transliterate", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ options: [] });
  try {
    const r = await fetch(`https://inputtools.google.com/request?itc=ta-t-i0-und&num=5&text=${encodeURIComponent(text)}`);
    const j = await r.json();
    res.json({ options: j[0] === "SUCCESS" ? j[1][0][1] : [] });
  } catch (e) {
    res.json({ options: [] });
  }
});

app.get("/", (req, res) => res.send("Sollagarathi API Live"));

app.listen(process.env.PORT || 3000, () => console.log("🚀 Server spinning on Render"));
