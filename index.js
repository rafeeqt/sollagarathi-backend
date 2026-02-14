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

    await pool.query(`
      create table if not exists master_entries (
        id serial primary key,
        lemma text unique,
        entry text,
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

// 🔍 Multi-source Search (collect ALL results)
app.get("/search/:word", async (req, res) => {
  const { word } = req.params;
  const results = [];

  try {
    await pool.query(
      "INSERT INTO search_history(tamil_word) VALUES($1)",
      [word]
    );



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
          source: "",
          text: page.extract
        });
      }
    } catch {}

    // 2️⃣ Tamil lex
    try {
      const TamillexUrl =
        "https://dsal.uchicago.edu/dictionaries/tamil-lex/" + encodeURIComponent(word);

      const r2 = await fetch(TamillexUrl);
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

    // 3️⃣ Thanithamizh
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

    // 4️⃣ DSAL
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

// 🔤 Transliterate: English letters → Tamil suggestions
app.post("/transliterate", async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.json({ options: [] });
  }

  try {
    const url =
      "https://inputtools.google.com/request?itc=ta-t-i0-und&num=10&text=" +
      encodeURIComponent(text);

    const r = await fetch(url);
    const j = await r.json();

    // Google API format: ["SUCCESS", [[ "aram", ["அறம்","ஆரம்","அரம்"], ... ]]]
    if (j[0] === "SUCCESS" && j[1]?.length) {
      const options = j[1][0][1];
      return res.json({ options });
    }

    return res.json({ options: [] });
  } catch (e) {
    console.error("TRANSLITERATE ERROR:", e.message);
    return res.json({ options: [] });
  }
});

// 🧠 Resolve Stage – English/Tamil workflow
app.post("/resolve", async (req, res) => {
  const { query } = req.body;

  const isTamil = /[\u0B80-\u0BFF]/.test(query);

  if (!isTamil) {
    // English → Tamil options (placeholder logic)
    const options = [
      query + "ம்",
      query + "ல்",
      "அன்பு",
      "நன்மை"
    ];

    return res.json({
      stage: "choose",
      options
    });
  }

  const canonical = query.trim();

  const r = await pool.query(
    "select entry from master_entries where lemma=$1",
    [canonical]
  );

  if (r.rows.length) {
    return res.json({
      stage: "entry",
      lemma: canonical,
      entry: r.rows[0].entry
    });
  }

  return res.json({
    stage: "entry",
    lemma: canonical,
    entry: `<i>இந்த சொல் புதிது. முழு Tamil-OED பதிவாக உருவாக்க தயாராக உள்ளது.</i>`
  });
});

// 🏗 Finalize – Create Master Entry
app.post("/finalize", async (req, res) => {
  const { word } = req.body;

  const entry = `
  <b>சொல்:</b> ${word}<br>
  <b>வேர்:</b> —<br>
  <b>மூல மொழி:</b> —<br>
  <b>வரலாறு:</b> —<br>
  <b>பொருள் வளர்ச்சி:</b> —<br>
  <b>இலக்கிய மேற்கோள்:</b> —<br>
  <b>அறிஞர் கருத்து:</b> —<br>
  <b>இணைப்புகள்:</b> —<br>
  `;

  await pool.query(
    `insert into master_entries(lemma, entry)
     values($1,$2)
     on conflict (lemma) do update set entry=$2`,
    [word, entry]
  );

  res.json({
    lemma: word,
    entry
  });
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server started")
);

// 🇬🇧 English → Tamil suggestion 
app.post("/suggest/english", async (req, res) => {
  const { word } = req.body;
  if (!word) return res.json({ options: [] });

  const map = {
    virtue: ["அறம்", "நற்பண்பு", "ஒழுக்கம்"],
    love: ["அன்பு", "காதல்"],
    justice: ["நீதி"],
    knowledge: ["அறிவு"],
    duty: ["கடமை"]
  };

  const key = word.toLowerCase();
  return res.json({
    options: map[key] || []
  });
});

// 🔤 Tamil neighbourhood (prefix-based)
app.get("/neighbours/:word", async (req, res) => {
  const { word } = req.params;

  try {
    const r = await pool.query(
      `SELECT tamil_word
       FROM words
       WHERE tamil_word LIKE $1
       ORDER BY tamil_word
       LIMIT 20`,
      [word + "%"]
    );

    res.json({
      words: r.rows.map(x => x.tamil_word)
    });
  } catch (e) {
    res.json({ words: [] });
  }
});

app.get("/__test", (req, res) => {
  res.json({ ok: true });
});
