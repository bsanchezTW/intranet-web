/** Noticias destacadas en el inicio. */
module.exports = {
  id: "003_news_featured",
  async up(client) {
    await client.query(
      "ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_news_articles_featured ON news_articles (featured) WHERE featured = true",
    );
  },
};
