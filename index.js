import express from "express";
import cors from "cors";
import pkg from "pg";
import fetch from "node-fetch";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

app.get("/", (req, res) => {
  res.send("Sollagarathi Backend Running");
});

// Word of the Day
app.get("/word-of-the-day", async (req, res) => {
  const r = await pool.query(
    `SELECT tamil_word 
     FROM search_history 
     GROUP BY tamil_word 
     ORDER BY COUNT(*) DESC 
     LIMIT 1`
  );
  res.json(r.rows[0] || {});
});

// Search with fallback
app.get("/search/:word", async (req, res) => {
  const { word } = req.params;

  await pool.query(
    "INSERT INTO search_history(tamil_word) VALUES($1)",
    [word]
  );

  // 1️⃣ Local DB
  const local = await pool.query(
    "SELECT * FROM words WHERE tamil_word=$1",
    [word]
  );

  if (local.rows.length > 0) {
    return res.json({
      source: "local",
      data: local.rows
    });
  }

  // 2️⃣ Wiktionary fallback
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

      return res.json({
        source: "wiktionary",
        text: page.extract
      });
    }

    return res.json({
      source: "none",
      data: []
    });
  } catch (e) {
    return res.json({
      source: "error",
      message: "Online source unreachable"
    });
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server started")
);
