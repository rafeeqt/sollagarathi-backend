import express from "express";
import cors from "cors";
import pkg from "pg";

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

app.get("/search/:word", async (req, res) => {
  const { word } = req.params;

  await pool.query(
    "INSERT INTO search_history(tamil_word) VALUES($1)",
    [word]
  );

  const result = await pool.query(
    "SELECT * FROM words WHERE tamil_word=$1",
    [word]
  );

  res.json(result.rows);
});

// NEW ENDPOINT
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

app.listen(process.env.PORT || 3000, () =>
  console.log("Server started")
);
