/**
 * PROJECT: சொல் அகராதி (Sollagarathi) - Tamil Lexicon
 * PURPOSE: Backend API for Search, Transliteration, and Scholar Management
 * TECHNOLOGY: Node.js, Express, PostgreSQL (pg)
 */ 

import express from "express";
import cors from "cors";
import pkg from "pg";
import fetch from "node-fetch";

const { Pool } = pkg;
const app = express();

// MIDDLEWARE: Enable CORS for frontend access and JSON parsing for POST bodies
app.use(cors());
app.use(express.json());

// DATABASE CONNECTION: Connects to Supabase/PostgreSQL via Environment Variables
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * ROUTE: POST /resolve
 * DESCRIPTION: Resolves a search query by checking the local Master DB first,
 * then falling back to the Wiktionary API.
 */
app.post("/resolve", async (req, res) => {
  const { query } = req.body;
  
  // LOGGING: Track search queries in the Render dashboard console
  console.log("Searching for:", query);
  
  try {
    // 1. LOCAL SEARCH: Search within the internal master_entries table
    const local = await pool.query("SELECT * FROM master_entries WHERE lemma = $1", [query]);
    if (local.rows.length > 0) {
      console.log("Match found: Local DB");
      return res.json({ 
        stage: "entry", 
        source: "சொல் அகராதி (Master DB)", 
        lemma: local.rows[0].lemma, 
        entry: local.rows[0].entry 
      });
    }

    // 2. EXTERNAL SEARCH: Fetch data from Wiktionary if local search fails
    const wikiUrl = `https://ta.wiktionary.org/w/api.php?action=query&format=json&origin=*&prop=extracts&explaintext=1&titles=${encodeURIComponent(query)}`;
    const wikiRes = await fetch(wikiUrl);
    const wikiJson = await wikiRes.json();
    const page = wikiJson.query.pages[Object.keys(wikiJson.query.pages)[0]];

    if (page && page.extract) {
      console.log("Match found: Wiktionary");
      return res.json({ 
        stage: "entry", 
        source: "விக்சனரி (Wiktionary)", 
        lemma: query, 
        entry: page.extract 
      });
    }

    // 3. NO MATCH: Inform frontend that no definitions were found
    console.log("No results found for query:", query);
    res.json({ stage: "choose", options: [query] });

  } catch (err) {
    console.error("DATABASE/API ERROR:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * ROUTE: GET /
 * DESCRIPTION: Health check endpoint to ensure server is awake
 */
app.get("/", (req, res) => res.send("அகராதி தளம் இயங்குகிறது (Server Active)"));

// SERVER INITIALIZATION
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
