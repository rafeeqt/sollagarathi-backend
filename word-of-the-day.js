app.get("/word-of-the-day", async (req, res) => {
  const r = await pool.query(
    "SELECT tamil_word FROM search_history GROUP BY tamil_word ORDER BY COUNT(*) DESC LIMIT 1"
  );
  res.json(r.rows[0] || {});
});
