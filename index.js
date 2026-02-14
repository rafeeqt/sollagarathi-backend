import express from "express";
import cors from "cors";
import pkg from "pg";
import fetch from "node-fetch";
import dns from "dns";

// Force Node.js to prefer IPv4 for Supabase stability on Render
dns.setDefaultResultOrder("ipv4first");

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json());

// 1. DATABASE CONNECTION
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4
});

// 2. DATABASE INITIALIZATION (Ensuring tables exist)
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

// 3. SEO: DYNAMIC SITEMAP.XML
// Pulls up to 15,000 words from Supabase for Google indexing
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

// 4. THE CORE SEARCH API (Multi-Source Waterfall)
app.get("/api/word/:word", async (req, res) => {
  const { word } = req.params;
  const wordData = { lemma: word, results: [] };

  try {
    // A. Log to History
    await pool.query("INSERT INTO search_history(tamil_word) VALUES($1)", [word]);

    // B. Check Supabase "Word Bank"
    const local = await pool.query("SELECT entry FROM master_entries WHERE lemma = $1", [word]);
    if (local.rows.length > 0) {
      wordData.results.push({ 
        source: "Sollagarathi Master", 
        text: local.rows[0].entry 
      });
    }

    // C. Wiktionary API
    try {
      const wikiRes = await fetch(`https://ta.wiktionary.org/w/api.php?action=query&format=json&origin=*&prop=extracts&explaintext=1&titles=${encodeURIComponent(word)}`);
      const wikiJson = await wikiRes.json();
      const page = wikiJson.query.pages[Object.keys(wikiJson.query.pages)[0]];
      if (page && page.extract) {
        wordData.results.push({ source: "Wiktionary (தமிழ்)", text: page.extract });
      }
    } catch (e) {}

    // D. University of Chicago (DSAL)
    const dsalUrl = `https://dsal.uchicago.edu/cgi-bin/app/tamil-lexicon_query.py?qs=${encodeURIComponent(word)}`;
    wordData.results.push({ 
      source: "University of Madras Lexicon (DSAL)", 
      url: dsalUrl, 
      text: "சென்னைப் பல்கலைக்கழகத் தமிழ்ப் பேரகராதி விளக்கம்.",
      type: "link" 
    });

    // E. அகராதி.com
    const agarathiUrl = `https://www.அகராதி.com/s/tamil/${encodeURIComponent(word)}`;
    wordData.results.push({
      source: "அகராதி.com",
      url: agarathiUrl,
      text: "அகராதி.com தளத்தில் விளக்கத்தைப் பார்க்க.",
      type: "link"
    });

    res.json(wordData);
  } catch (err) {
    res.status(500).json({ error: "Internal Search Error" });
  }
});

// 5. GOOGLE TRANSLITERATION (English -> Tamil typing)
app.post("/transliterate", async (req, res) => {
  const { text } = req.body;
  
  if (!text) {
    return res.json({ options: [] });
  }

  try {
    // We fetch from Google's public input tools API
    const googleUrl = `https://inputtools.google.com/request?itc=ta-t-i0-und&num=5&cp=0&cs=1&ie=utf-8&oe=utf-8&app=demopage&text=${encodeURIComponent(text)}`;
    
    const response = await fetch(googleUrl);
    const data = await response.json();

    if (data[0] === "SUCCESS") {
      // data[1][0][1] contains the list of Tamil word suggestions
      const tamilOptions = data[1][0][1];
      res.json({ options: tamilOptions });
    } else {
      res.json({ options: [] });
    }
  } catch (error) {
    console.error("Transliteration Error:", error);
    res.status(500).json({ error: "Failed to fetch transliteration" });
  }
});


// 6. WORD OF THE DAY (Most searched word)
app.get("/word-of-the-day", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT tamil_word FROM search_history 
      GROUP BY tamil_word ORDER BY COUNT(*) DESC LIMIT 1
    `);
    res.json(r.rows[0] || { tamil_word: "அறம்" });
  } catch {
    res.json({ tamil_word: "அறம்" });
  }
});

// 7. HEALTH CHECK & PORT
app.get("/", (req, res) => res.send("Sollagarathi Backend is Active"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// A. Register a Contributor
app.post("/api/contributors/register", async (req, res) => {
  const { full_name, email, role, qualification, institution } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO contributors (full_name, email, role, qualification, institution, status) 
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING contributor_id`,
      [full_name, email, role, qualification, institution]
    );
    res.json({ success: true, id: result.rows[0].contributor_id, message: "Application submitted for review." });
  } catch (err) {
    res.status(400).json({ error: "Email already registered or invalid data." });
  }
});

// B. Propose a Word Version (The "Draft" Layer)
app.post("/api/propose-version", async (req, res) => {
  const { word_id, field_name, field_value, source, contributor_id } = req.body;
  try {
    await pool.query(
      `INSERT INTO word_versions (word_id, field_name, field_value, source, contributor_id, status) 
       VALUES ($1, $2, $3, $4, $5, 'draft')`,
      [word_id, field_name, field_value, source, contributor_id]
    );
    res.json({ success: true, message: "Draft saved for moderator approval." });
  } catch (err) {
    res.status(500).json({ error: "Could not save draft." });
  }
});

app.post("/api/contributors/register", async (req, res) => {
  const { full_name, email, role, qualification, institution } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO contributors (full_name, email, role, qualification, institution) 
       VALUES ($1, $2, $3, $4, $5) RETURNING contributor_id`,
      [full_name, email, role, qualification, institution]
    );
    res.json({ success: true, id: result.rows[0].contributor_id });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "மின்னஞ்சல் ஏற்கனவே பதிவில் உள்ளது அல்லது தவறான விவரம்." });
  }
});
