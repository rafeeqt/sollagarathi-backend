import express from "express";
import cors from "cors";
import pkg from "pg";
import fetch from "node-fetch";
import dns from "dns";
import cron from "node-cron"; // Added scheduler

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

// 2. DATABASE INITIALIZATION & AUTOMATION
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

// --- NEW: DAILY WORD SYNC AUTOMATION --
async function dailyWordSync() {
  console.log("⏳ Starting Daily Word Sync...");
  try {
    const source = "https://raw.githubusercontent.com/mskian/tamil-words/master/words.txt";
    const res = await fetch(source);
    const text = await res.text();
    const words = text.split('\n').slice(0, 10000); // Top 10k words

    for (let w of words) {
      const word = w.trim();
      if (!word) continue;

      // ON CONFLICT (lemma) DO NOTHING protects existing grammar/edits
      await pool.query(`
        INSERT INTO master_entries (lemma, entry) 
        VALUES ($1, $2) 
        ON CONFLICT (lemma) DO NOTHING`, 
        [word, `<i>Sollagarathi database entry for ${word}</i>`]
      );
    }
    console.log("✅ Daily Sync Complete. No duplicates added.");
  } catch (err) {
    console.error("❌ Sync Error:", err.message);
  }
}

// Schedule: Runs every day at Midnight (00:00)
cron.schedule('0 0 * * *', () => {
  dailyWordSync();
});

// 3. SEO: DYNAMIC SITEMAP.XML
app.get("/sitemap.xml", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT lemma FROM master_entries LIMIT 15000");
    res.header('Content-Type', 'application/xml');
    let xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
    xml += `\n<url><loc>https://sollagarathi.com/</loc><priority>1.0</priority></url>`;
    rows.forEach(row => {
      xml += `\n<url><loc>https://sollagarathi.com/word/${encodeURIComponent(row.lemma)}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`;
    });
    xml += `\n</urlset>`;
    res.send(xml);
  } catch (err) {
    res.status(500).end();
  }
});

// 4. THE CORE SEARCH API
app.get("/api/word/:word", async (req, res) => {
  const { word } = req.params;
  const wordData = { lemma: word, results: [] };
  try {
    await pool.query("INSERT INTO search_history(tamil_word) VALUES($1)", [word]);
    const local = await pool.query("SELECT entry FROM master_entries WHERE lemma = $1", [word]);
    if (local.rows.length > 0) {
      wordData.results.push({ source: "Sollagarathi Master", text: local.rows[0].entry });
    }
    // ... Wiktionary, DSAL, Agarathi logic remains same ...
    try {
      const wikiRes = await fetch(`https://ta.wiktionary.org/w/api.php?action=query&format=json&origin=*&prop=extracts&explaintext=1&titles=${encodeURIComponent(word)}`);
      const wikiJson = await wikiRes.json();
      const page = wikiJson.query.pages[Object.keys(wikiJson.query.pages)[0]];
      if (page && page.extract) wordData.results.push({ source: "Wiktionary (தமிழ்)", text: page.extract });
    } catch (e) {}
    
    wordData.results.push({ source: "University of Madras Lexicon (DSAL)", url: `https://dsal.uchicago.edu/cgi-bin/app/tamil-lexicon_query.py?qs=${encodeURIComponent(word)}`, text: "சென்னைப் பல்கலைக்கழகத் தமிழ்ப் பேரகராதி விளக்கம்.", type: "link" });
    wordData.results.push({ source: "அகராதி.com", url: `https://www.அகராதி.com/s/tamil/${encodeURIComponent(word)}`, text: "அகராதி.com தளத்தில் விளக்கத்தைப் பார்க்க.", type: "link" });

    res.json(wordData);
  } catch (err) {
    res.status(500).json({ error: "Internal Search Error" });
  }
});

const getExternalLinks = (word) => {
  return [
    { name: "Wiktionary", url: `https://ta.wiktionary.org/wiki/${encodeURIComponent(word)}` },
    { name: "Tamil Lexicon", url: `https://dsal.uchicago.edu/cgi-bin/app/tamil-lex_query.py?qs=${encodeURIComponent(word)}` },
    { name: "Winslow", url: `https://dsal.uchicago.edu/cgi-bin/app/winslow_query.py?qs=${encodeURIComponent(word)}` },
    { name: "Mydictionary", url: `https://mydictionary.in/search?q=${encodeURIComponent(word)}` }
  ];
};

// Update your search route to include these links
app.get("/resolve/:word", async (req, res) => {
  const word = req.params.word;
  // ... your existing Supabase logic ...
  
  res.json({
    local_data: result.rows[0],
    external_links: getExternalLinks(word)
  });
});

// 5. GOOGLE TRANSLITERATION
app.post("/transliterate", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ options: [] });
  try {
    const googleUrl = `https://inputtools.google.com/request?itc=ta-t-i0-und&num=5&cp=0&cs=1&ie=utf-8&oe=utf-8&app=demopage&text=${encodeURIComponent(text)}`;
    const response = await fetch(googleUrl);
    const data = await response.json();
    res.set("Access-Control-Allow-Origin", "*"); 
    res.json({ options: data[0] === "SUCCESS" ? data[1][0][1] : [] });
  } catch (e) {
    res.json({ options: [] });
  }
});

// 6. WORD OF THE DAY
app.get("/word-of-the-day", async (req, res) => {
  try {
    const r = await pool.query(`SELECT tamil_word FROM search_history GROUP BY tamil_word ORDER BY COUNT(*) DESC LIMIT 1`);
    res.json(r.rows[0] || { tamil_word: "அறம்" });
  } catch {
    res.json({ tamil_word: "அறம்" });
  }
});

// 7. CONTRIBUTOR ROUTES
app.post("/api/contributors/register", async (req, res) => {
  const { full_name, email, role, qualification, institution } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO contributors (full_name, email, role, qualification, institution, status) 
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING contributor_id`,
      [full_name, email, role, qualification, institution]
    );
    res.json({ success: true, id: result.rows[0].contributor_id });
  } catch (err) {
    res.status(400).json({ error: "மின்னஞ்சல் ஏற்கனவே உள்ளது." });
  }
});

// 8. HEALTH CHECK & PORT
app.get("/", (req, res) => res.send("Sollagarathi Backend is Active"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// 9. SECRET STATUS DASHBOARD
app.get("/status", async (req, res) => {
  const secretKey = "sollagarathi2026"; // Change this to your preferred "password"
  const userKey = req.query.key;

  if (userKey !== secretKey) {
    return res.status(401).send("🔒 Unauthorized: Secret key required.");
  }

  try {
    // 1. Get total words
    const wordCount = await pool.query("SELECT COUNT(*) FROM master_entries");
    
    // 2. Get history count (total searches)
    const searchCount = await pool.query("SELECT COUNT(*) FROM search_history");

    // 3. Get last 5 searched words
    const recentSearches = await pool.query("SELECT tamil_word, searched_at FROM search_history ORDER BY searched_at DESC LIMIT 5");

    // Construct a simple HTML view
    let html = `
      <body style="font-family: sans-serif; padding: 40px; line-height: 1.6; background: #f4f4f9;">
        <h1 style="color: #2c3e50;">📊 Sollagarathi Backend Status</h1>
        <hr>
        <div style="display: flex; gap: 20px;">
          <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); flex: 1;">
            <h3>📚 Total Words</h3>
            <p style="font-size: 24px; font-weight: bold; color: #27ae60;">${wordCount.rows[0].count}</p>
          </div>
          <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); flex: 1;">
            <h3>🔍 Total Searches</h3>
            <p style="font-size: 24px; font-weight: bold; color: #2980b9;">${searchCount.rows[0].count}</p>
          </div>
        </div>
        
        <h3>🕒 Recent Activity</h3>
        <ul style="background: white; padding: 20px; border-radius: 8px; list-style: none;">
          ${recentSearches.rows.map(r => `<li><b>${r.tamil_word}</b> - <small>${new Date(r.searched_at).toLocaleString()}</small></li>`).join('')}
        </ul>
        
        <p style="margin-top: 30px; font-size: 12px; color: #7f8c8d;">Sync Status: Active (Runs daily at 00:00)</p>
      </body>
    `;
    
    res.send(html);
  } catch (err) {
    res.status(500).send("Error fetching status: " + err.message);
  }
});
