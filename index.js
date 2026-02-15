// COMPLETE index.js REPLACEMENT
import express from "express";
import cors from "cors";
import pkg from "pg";
import fetch from "node-fetch";

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Added logging to see what's happening in Render Logs
app.post("/resolve", async (req, res) => {
  const { query } = req.body;
  console.log("Searching for:", query); // Check Render Logs for this
  
  try {
    const local = await pool.query("SELECT * FROM master_entries WHERE lemma = $1", [query]);
    
    if (local.rows.length > 0) {
      console.log("Found in DB");
      return res.json({ stage: "entry", lemma: local.rows[0].lemma, entry: local.rows[0].entry });
    }

    // Try Wiktionary
    const wiki = await fetch(`https://ta.wiktionary.org/w/api.php?action=query&format=json&origin=*&prop=extracts&explaintext=1&titles=${encodeURIComponent(query)}`);
    const wikiJson = await wiki.json();
    const page = wikiJson.query.pages[Object.keys(wikiJson.query.pages)[0]];

    if (page && page.extract) {
      console.log("Found in Wiktionary");
      return res.json({ stage: "entry", lemma: query, entry: page.extract });
    }

    console.log("No results found anywhere");
    res.json({ stage: "choose", options: [query] });
  } catch (err) {
    console.error("DATABASE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Simple Health Check
app.get("/", (req, res) => res.send("Active"));

app.listen(process.env.PORT || 3000, () => console.log("Server Live"));
