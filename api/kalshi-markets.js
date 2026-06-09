// Vercel serverless — all open Kalshi markets, grouped by category
// Fetches up to 3 pages (600 markets), converts prices to American odds
// Requires KALSHI_API_KEY env var

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

const CATEGORY_ORDER = [
    'sports', 'politics', 'economics', 'financials',
    'entertainment', 'technology', 'science', 'geopolitics', 'other',
];

const CATEGORY_LABELS = {
    sports:        '🏆 Sports',
    politics:      '🏛️ Politics',
    economics:     '📈 Economics',
    financials:    '💹 Financials',
    entertainment: '🎬 Entertainment',
    technology:    '💻 Technology',
    science:       '🔬 Science',
    geopolitics:   '🌍 Geopolitics',
    other:         '📋 Other',
};

function getHeaders() {
    const key = process.env.KALSHI_API_KEY || '';
    return {
        'Authorization': key.startsWith('Bearer ') ? key : `Bearer ${key}`,
        'Accept': 'application/json',
    };
}

function toAmericanOdds(priceCents) {
    if (priceCents == null || priceCents <= 0 || priceCents >= 100) return null;
    const p = priceCents / 100;
    return p >= 0.5
        ? Math.round(-(p / (1 - p)) * 100)
        : Math.round(((1 - p) / p) * 100);
}

function shapeMarket(m) {
    const yesAsk = m.yes_ask ?? null;
    const noAsk  = m.no_ask  ?? null;
    return {
        ticker:       m.ticker,
        eventTicker:  m.event_ticker  || null,
        seriesTicker: m.series_ticker || null,
        title:        m.title || m.subtitle || m.ticker,
        category:     (m.category || 'other').toLowerCase(),
        yesOdds:      toAmericanOdds(yesAsk),
        noOdds:       toAmericanOdds(noAsk),
        yesPct:       yesAsk,
        noPct:        noAsk,
        volume:       m.volume        || 0,
        openInterest: m.open_interest || 0,
        closeTime:    m.close_time    || null,
    };
}

async function fetchPage(cursor) {
    const params = new URLSearchParams({ status: 'open', limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const r = await fetch(`${KALSHI_BASE}/markets?${params}`, { headers: getHeaders() });
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`Kalshi ${r.status}: ${body.slice(0, 200)}`);
    }
    const d = await r.json();
    return { markets: d.markets || [], cursor: d.cursor || null };
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!process.env.KALSHI_API_KEY) {
        return res.status(200).json({
            categories: [], total: 0,
            error: 'KALSHI_API_KEY not set — add it in Vercel → Project Settings → Environment Variables',
            fetchedAt: new Date().toISOString(),
        });
    }

    try {
        // Fetch up to 3 pages (600 markets)
        const allRaw = [];
        let cursor = null;
        for (let page = 0; page < 3; page++) {
            const { markets, cursor: next } = await fetchPage(cursor);
            allRaw.push(...markets);
            cursor = next;
            if (!cursor || !markets.length) break;
        }

        // Group by category
        const grouped = {};
        allRaw.map(shapeMarket).forEach(m => {
            const cat = m.category || 'other';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(m);
        });

        // Build ordered category list, top 40 by volume per category
        const allCatKeys = [...new Set([...CATEGORY_ORDER, ...Object.keys(grouped)])];
        const categories = allCatKeys
            .filter(cat => grouped[cat]?.length > 0)
            .map(cat => ({
                id:      cat,
                label:   CATEGORY_LABELS[cat] || (cat.charAt(0).toUpperCase() + cat.slice(1)),
                markets: grouped[cat].sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 40),
                total:   grouped[cat].length,
            }));

        res.status(200).json({
            categories,
            total: allRaw.length,
            fetchedAt: new Date().toISOString(),
        });
    } catch (err) {
        res.status(200).json({
            categories: [], total: 0,
            error: err.message,
            fetchedAt: new Date().toISOString(),
        });
    }
};
