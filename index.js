import express from "express";
import cors from "cors";
import pkg from "pg";
import fetch from "node-fetch";
import dns from "dns";
import cron from "node-cron";

dns.setDefaultResultOrder("ipv4first");
const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// INITIALIZE DATABASE TABLES
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS search_history (id SERIAL PRIMARY KEY, tamil_word TEXT, searched_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS master_entries (id SERIAL PRIMARY KEY, lemma TEXT UNIQUE, entry TEXT, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS contributors (
        contributor_id SERIAL PRIMARY KEY, full_name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, 
        role TEXT, qualification TEXT, institution TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ DB Tables Verified");
  } catch (e) { console.error("❌ DB ERROR:", e.message); }
}
initDB();

// TRANSLITERATION (GOOGLE TOOLS)
app.post("/transliterate", async (req, res) => {
  const { text } = req.body;
  try {
    const url = `https://inputtools.google.com/request?itc=ta-t-i0-und&num=5&cp=0&cs=1&ie=utf-8&oe=utf-8&app=demopage&text=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    const data = await response.json();
    const options = (data[0] === "SUCCESS") ? data[1][0][1] : [];
    res.json({ options });
  } catch (e) { res.json({ options: [] }); }
});

// SEARCH LOGIC
app.post("/resolve", async (req, res) => {
  const { query } = req.body;
  try {
    await pool.query("INSERT INTO search_history(tamil_word) VALUES($1)", [query]);
    const local = await pool.query("SELECT lemma, entry FROM master_entries WHERE lemma = $1", [query]);
    
    if (local.rows.length > 0) {
      return res.json({ stage: "entry", lemma: local.rows[0].lemma, entry: local.rows[0].entry });
    }

    const wikiRes = await fetch(`https://ta.wiktionary.org/w/api.php?action=query&format=json&origin=*&prop=extracts&explaintext=1&titles=${encodeURIComponent(query)}`);
    const wikiJson = await wikiRes.json();
    const page = wikiJson.query.pages[Object.keys(wikiJson.query.pages)[0]];

    if (page && page.extract) {
      return res.json({ stage: "entry", lemma: query, entry: page.extract });
    }
    res.json({ stage: "choose", options: [query] });
  } catch (e) { res.status(500).json({ error: "Search Error" }); }
});

app.post("/finalize", async (req, res) => {
  const { word } = req.body;
  const entry = `அகராதி பதிவு: ${word}`;
  await pool.query("INSERT INTO master_entries(lemma, entry) VALUES($1,$2) ON CONFLICT DO NOTHING", [word, entry]);
  res.json({ lemma: word, entry: entry });
});

app.get("/word-of-the-day", async (req, res) => {
  const r = await pool.query
