// Live news intel for a mentions market — pulls recent headlines from
// Google News RSS (no API key required) so the YES/NO reasoning panel can
// show real-time context for the subject of the market.

function decodeEntities(s) {
    return (s || '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/<[^>]*>/g, '').trim();
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=120');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const q = (req.query?.q || '').toString().slice(0, 120).trim();
    if (!q) return res.status(200).json({ items: [], error: 'missing q' });

    try {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
        const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheBooth/1.0)' },
            signal: AbortSignal.timeout(6000),
        });
        if (!r.ok) return res.status(200).json({ items: [], error: `news fetch ${r.status}` });
        const xml = await r.text();

        const items = [];
        const itemRe = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = itemRe.exec(xml)) && items.length < 5) {
            const block = m[1];
            const title  = decodeEntities((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
            const link   = decodeEntities((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
            const pub    = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || null;
            const source = decodeEntities((block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]);
            if (title) items.push({ title, link, source, publishedAt: pub });
        }

        res.status(200).json({ items, q, fetchedAt: new Date().toISOString() });
    } catch (err) {
        res.status(200).json({ items: [], error: err.message });
    }
};
