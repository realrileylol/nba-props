// Vercel serverless — Kalshi prediction market data for NBA Finals word props
// Requires KALSHI_API_KEY env var (get from kalshi.com → Settings → API)
// Returns open markets matching broadcaster word prop searches

const KALSHI_BASE = 'https://trading-api.kalshi.com/trade-api/v2';

function headers() {
    const key = process.env.KALSHI_API_KEY || '';
    return {
        'Authorization': key.startsWith('Bearer ') ? key : `Bearer ${key}`,
        'Accept': 'application/json',
    };
}

async function searchMarkets(query, limit = 200) {
    const url = `${KALSHI_BASE}/markets?status=open&limit=${limit}&search=${encodeURIComponent(query)}`;
    const res  = await fetch(url, { headers: headers() });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Kalshi ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.markets || data.market_candidates || [];
}

function toAmericanOdds(priceCents) {
    if (priceCents == null || priceCents <= 0 || priceCents >= 100) return null;
    const p = priceCents / 100;
    return p >= 0.5
        ? Math.round(-(p / (1 - p)) * 100)
        : Math.round(((1 - p) / p) * 100);
}

function shape(m) {
    const yesAsk = m.yes_ask ?? null;
    const noAsk  = m.no_ask  ?? null;
    return {
        ticker:       m.ticker,
        title:        m.title || m.subtitle || m.ticker,
        category:     'sports',
        yesOdds:      toAmericanOdds(yesAsk),
        noOdds:       toAmericanOdds(noAsk),
        yesPct:       yesAsk,
        noPct:        noAsk,
        volume:       m.volume        || 0,
        openInterest: m.open_interest || 0,
        closeTime:    m.close_time    || null,
        status:       m.status,
    };
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=15');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const apiKey = process.env.KALSHI_API_KEY;
    if (!apiKey) {
        return res.status(200).json({
            markets: [],
            error: 'KALSHI_API_KEY not set — add it in Vercel → Project Settings → Environment Variables',
            fetchedAt: new Date().toISOString(),
        });
    }

    try {
        // Pull markets for each broadcaster + general NBA word props
        const [breens, jeffs, leglers, nbas] = await Promise.all([
            searchMarkets('Breen'),
            searchMarkets('Jefferson NBA'),
            searchMarkets('Legler'),
            searchMarkets('NBA Finals word'),
        ]);

        const all = [...breens, ...jeffs, ...leglers, ...nbas];

        // Deduplicate by ticker
        const seen = new Set();
        const unique = all.filter(m => {
            if (seen.has(m.ticker)) return false;
            seen.add(m.ticker);
            return true;
        });

        // Prefer markets that look like word/phrase props
        const wordPropTerms = /say|says|word|bang|mention|nba|final|breen|jefferson|legler/i;
        const sorted = unique.sort((a, b) => {
            const aScore = wordPropTerms.test(a.title || '') ? 1 : 0;
            const bScore = wordPropTerms.test(b.title || '') ? 1 : 0;
            return bScore - aScore || (b.volume || 0) - (a.volume || 0);
        });

        res.status(200).json({
            markets: sorted.map(shape),
            total: sorted.length,
            fetchedAt: new Date().toISOString(),
        });
    } catch (err) {
        res.status(200).json({
            markets: [],
            error: err.message,
            fetchedAt: new Date().toISOString(),
        });
    }
};
