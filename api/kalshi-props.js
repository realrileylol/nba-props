// Kalshi markets by series_ticker — bypasses combo/parlay market noise
// Fetches individual markets directly from known series across Sports + Politics + Economics + Crypto
// Returns: { groups: [{id, label, icon, markets}], total, fetchedAt }

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

function getHeaders() {
    const key = process.env.KALSHI_API_KEY || '';
    return {
        'Authorization': key.startsWith('Bearer ') ? key : `Bearer ${key}`,
        'Accept': 'application/json',
    };
}

// Fetch markets for one series — fails silently so one bad series doesn't kill the whole request
async function fetchSeries(seriesTicker) {
    try {
        const url = `${KALSHI_BASE}/markets?status=open&limit=50&series_ticker=${encodeURIComponent(seriesTicker)}`;
        const r = await fetch(url, { headers: getHeaders(), signal: AbortSignal.timeout(5000) });
        if (!r.ok) return [];
        const d = await r.json();
        return d.markets || [];
    } catch (_) {
        return [];
    }
}

// All known series tickers, labeled by group
// Sports covers current active leagues; Politics, Economics, Crypto cover standing markets
const SERIES = [
    // ── Sports ──────────────────────────────────────────────────
    { ticker: 'KXNBA',     group: 'sports' },
    { ticker: 'NBAFINALS', group: 'sports' },
    { ticker: 'KXMLBHIT',  group: 'sports' },   // MLB individual player hit props
    { ticker: 'KXMLB',     group: 'sports' },
    { ticker: 'KXNFL',     group: 'sports' },
    { ticker: 'KXNHL',     group: 'sports' },
    { ticker: 'KXMLS',     group: 'sports' },
    { ticker: 'KXSOC',     group: 'sports' },
    // ── Politics ─────────────────────────────────────────────────
    { ticker: 'INX',       group: 'politics' },
    { ticker: 'KXPOL',     group: 'politics' },
    { ticker: 'KXPOTUS',   group: 'politics' },
    { ticker: 'CONGRESS',  group: 'politics' },
    // ── Economics ────────────────────────────────────────────────
    { ticker: 'FED',       group: 'economics' },
    { ticker: 'CPI',       group: 'economics' },
    { ticker: 'NFP',       group: 'economics' },
    { ticker: 'KXECON',    group: 'economics' },
    { ticker: 'FOMC',      group: 'economics' },
    // ── Crypto ───────────────────────────────────────────────────
    { ticker: 'KXBTC',     group: 'crypto' },
    { ticker: 'KXETH',     group: 'crypto' },
    { ticker: 'BTC',       group: 'crypto' },
];

const GROUP_META = {
    sports:    { id: 'sports',    label: '🏀 Sports',    icon: '🏀' },
    politics:  { id: 'politics',  label: '🏛️ Politics',  icon: '🏛️' },
    economics: { id: 'economics', label: '📈 Economics', icon: '📈' },
    crypto:    { id: 'crypto',    label: '₿ Crypto',     icon: '₿' },
};
const GROUP_ORDER = ['sports', 'politics', 'economics', 'crypto'];

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
        subtitle:     m.subtitle || null,
        yesOdds:      toAmericanOdds(yesAsk),
        noOdds:       toAmericanOdds(noAsk),
        yesPct:       yesAsk,
        noPct:        noAsk,
        volume:       m.volume        || 0,
        openInterest: m.open_interest || 0,
        closeTime:    m.close_time    || null,
    };
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=15');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!process.env.KALSHI_API_KEY) {
        return res.status(200).json({
            groups: [], total: 0,
            error: 'KALSHI_API_KEY not set — add it in Vercel → Project Settings → Environment Variables',
            fetchedAt: new Date().toISOString(),
        });
    }

    try {
        // Fetch all series in parallel — each fails silently
        const results = await Promise.all(SERIES.map(s => fetchSeries(s.ticker)));

        // Accumulate markets by group, dedup by ticker
        const buckets = { sports: [], politics: [], economics: [], crypto: [] };
        const seen = new Set();

        SERIES.forEach(({ ticker, group }, i) => {
            results[i].forEach(m => {
                if (seen.has(m.ticker)) return;
                seen.add(m.ticker);
                buckets[group].push(shape(m));
            });
        });

        // Sort each bucket by volume, cap at 60 markets per group
        GROUP_ORDER.forEach(id => {
            buckets[id] = buckets[id]
                .sort((a, b) => (b.volume || 0) - (a.volume || 0))
                .slice(0, 60);
        });

        const groups = GROUP_ORDER
            .filter(id => buckets[id].length > 0)
            .map(id => ({ ...GROUP_META[id], markets: buckets[id] }));

        const total = groups.reduce((s, g) => s + g.markets.length, 0);

        res.status(200).json({ groups, total, fetchedAt: new Date().toISOString() });
    } catch (err) {
        res.status(200).json({
            groups: [], total: 0,
            error: err.message,
            fetchedAt: new Date().toISOString(),
        });
    }
};
