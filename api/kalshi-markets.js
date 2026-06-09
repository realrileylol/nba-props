// Vercel serverless — Kalshi markets organized by event, matching Kalshi's own layout
// Fetches event titles from /events endpoint + market prices from /markets endpoint
// Groups by sport/topic; within each category groups by event_ticker
//
// Timing budget: Vercel Hobby = 10s hard limit.
//   fetchEventTitles: 1 page, 4s timeout  → ≤4s
//   fetchMarkets:     1 page, 5s timeout  → ≤5s
//   Both run in parallel                  → ≤5s total, well within limit.

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

const CATEGORY_DEFS = [
    {
        id: 'nba', label: '🏀 NBA',
        series: /^(KXNBA|NBA|NBAFINALS)/i,
        title:  /\bnba\b|knicks|thunder|celtics|lakers|warriors|heat|nuggets|breen|jefferson|legler|nba finals|basketball|lebron|curry/i,
    },
    {
        id: 'mlb', label: '⚾ MLB',
        series: /^(KXMLB|MLB)/i,
        title:  /\bmlb\b|yankees|dodgers|red sox|cubs|mets|braves|astros|baseball|innings|home run|strikeout/i,
    },
    {
        id: 'nfl', label: '🏈 NFL',
        series: /^(KXNFL|NFL)/i,
        title:  /\bnfl\b|touchdown|super bowl|quarterback|mahomes|ravens|chiefs|eagles|patriots/i,
    },
    {
        id: 'nhl', label: '🏒 NHL',
        series: /^(KXNHL|NHL)/i,
        title:  /\bnhl\b|hockey|stanley cup|power play|penalty/i,
    },
    {
        id: 'soccer', label: '⚽ Soccer',
        series: /^(SOC|KXSOC|KXMLS|MLS|FIFA)/i,
        title:  /world cup|premier league|\bsoccer\b|\bfootball\b.*goal|la liga|bundesliga|serie a|mls|champions league/i,
    },
    {
        id: 'politics', label: '🏛️ Politics',
        series: /^(INX|POL|KXPOL|POTUS|CONGRESS|SENATE)/i,
        title:  /president|congress|senate|trump|election|tariff|border|supreme court|white house|executive order|veto|filibuster|inaugur/i,
    },
    {
        id: 'economics', label: '📈 Economics',
        series: /^(FED|CPI|NFP|ECON|KXECON|FOMC|PCE)/i,
        title:  /fed rate|fomc|inflation|cpi|payroll|unemployment|gdp|jobs report|interest rate|basis point|rate cut|rate hike|pce|nfp/i,
    },
    {
        id: 'crypto', label: '₿ Crypto',
        series: /^(BTC|ETH|SOL|KXBTC|KXETH)/i,
        title:  /bitcoin|\bbtc\b|ethereum|\beth\b|crypto|solana|ripple|\bxrp\b|binance/i,
    },
    {
        id: 'tech', label: '💻 Tech',
        series: /^(AAPL|GOOG|MSFT|AMZN|META|NVDA|TSLA|TECH)/i,
        title:  /\bapple\b|\bgoogle\b|microsoft|amazon|\bmeta\b|nvidia|tesla|ai model|earnings per share|stock price|market cap/i,
    },
    {
        id: 'entertainment', label: '🎬 Entertainment',
        series: /^(ENT|OSCARS|EMMY|GRAMMY)/i,
        title:  /oscar|emmy|grammy|academy award|box office|opening weekend|concert|album sales/i,
    },
];

function inferCategory(m) {
    const st    = m.series_ticker || m.event_ticker || m.ticker || '';
    const title = m.title || '';
    for (const def of CATEGORY_DEFS) {
        if (def.series.test(st) || def.title.test(title)) return def.id;
    }
    return (m.category || 'other').toLowerCase();
}

function isSimpleMarket(m) {
    const t = m.title || '';
    if ((t.match(/\b(yes|no)\s+\S/gi) || []).length > 1) return false;
    if ((t.match(/,/g) || []).length >= 7) return false;
    return true;
}

function toAmericanOdds(priceCents) {
    if (!priceCents || priceCents <= 0 || priceCents >= 100) return null;
    const p = priceCents / 100;
    return p >= 0.5
        ? Math.round(-(p / (1 - p)) * 100)
        : Math.round(((1 - p) / p) * 100);
}

function shapeMarket(m, eventTitle) {
    return {
        ticker:       m.ticker,
        seriesTicker: m.series_ticker || null,
        eventTicker:  m.event_ticker  || null,
        eventTitle:   eventTitle      || null,
        title:        m.title || m.ticker,
        subtitle:     m.subtitle      || null,
        category:     inferCategory(m),
        yesOdds:      toAmericanOdds(m.yes_ask),
        noOdds:       toAmericanOdds(m.no_ask),
        yesBid:       m.yes_bid       || null,
        yesPct:       m.yes_ask       || null,
        noPct:        m.no_ask        || null,
        volume:       m.volume        || 0,
        openInterest: m.open_interest || 0,
        closeTime:    m.close_time    || null,
    };
}

function getHeaders() {
    const key = process.env.KALSHI_API_KEY || '';
    return {
        'Authorization': key.startsWith('Bearer ') ? key : `Bearer ${key}`,
        'Accept': 'application/json',
    };
}

// Single-page fetch of event titles — best-effort, fails silently (4s budget)
async function fetchEventTitles() {
    const titleMap = {};
    try {
        const params = new URLSearchParams({ status: 'open', limit: '200' });
        const r = await fetch(`${KALSHI_BASE}/events?${params}`, {
            headers: getHeaders(),
            signal: AbortSignal.timeout(4000),
        });
        if (!r.ok) return titleMap;
        const d = await r.json();
        (d.events || []).forEach(e => {
            if (e.event_ticker && e.title) titleMap[e.event_ticker] = e.title;
        });
    } catch (_) { /* supplementary — fail silently */ }
    return titleMap;
}

// Single-page fetch of markets (5s budget — one 200-market page is plenty)
async function fetchMarkets() {
    const params = new URLSearchParams({ status: 'open', limit: '200' });
    const r = await fetch(`${KALSHI_BASE}/markets?${params}`, {
        headers: getHeaders(),
        signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`Kalshi ${r.status}: ${body.slice(0, 300)}`);
    }
    const d = await r.json();
    return d.markets || [];
}

module.exports = async (req, res) => {
    // Short cache — fresh data matters; stale-while-revalidate keeps UI snappy
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=20');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!process.env.KALSHI_API_KEY) {
        return res.status(200).json({
            categories: [], total: 0,
            error: 'KALSHI_API_KEY not set — add it in Vercel → Project Settings → Environment Variables',
            fetchedAt: new Date().toISOString(),
        });
    }

    try {
        // Both fetches in parallel — combined budget ≤5s (the slower of the two)
        const [eventTitles, allRaw] = await Promise.all([
            fetchEventTitles(),
            fetchMarkets(),
        ]);

        const filtered = allRaw.filter(isSimpleMarket);
        const shaped   = filtered.map(m => shapeMarket(m, eventTitles[m.event_ticker] || null));

        const grouped = {};
        shaped.forEach(m => {
            const c = m.category;
            if (!grouped[c]) grouped[c] = [];
            grouped[c].push(m);
        });

        const LABEL_MAP = {
            nba: '🏀 NBA', mlb: '⚾ MLB', nfl: '🏈 NFL', nhl: '🏒 NHL',
            soccer: '⚽ Soccer', politics: '🏛️ Politics', economics: '📈 Economics',
            crypto: '₿ Crypto', tech: '💻 Tech', entertainment: '🎬 Entertainment', other: '📋 Other',
        };
        const ORDER = ['nba','mlb','nfl','nhl','soccer','politics','economics','crypto','tech','entertainment','other'];
        const allKeys = [...new Set([...ORDER, ...Object.keys(grouped)])];

        let categories = allKeys
            .filter(c => grouped[c]?.length > 0)
            .map(c => ({
                id:      c,
                label:   LABEL_MAP[c] || (c.charAt(0).toUpperCase() + c.slice(1)),
                markets: grouped[c].sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 100),
                total:   grouped[c].length,
            }));

        // Fallback: if category regex matched nothing, dump everything into Other
        if (!categories.length && shaped.length) {
            categories = [{
                id: 'other', label: '📋 All Markets',
                markets: [...shaped].sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 100),
                total: shaped.length,
            }];
        }

        res.status(200).json({
            categories,
            total: shaped.length,
            rawTotal: allRaw.length,
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
