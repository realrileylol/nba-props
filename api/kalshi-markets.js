// Vercel serverless — Kalshi markets organized by event, matching Kalshi's own layout
// Fetches event titles from /events endpoint + market prices from /markets endpoint
// Groups by sport/topic; within each category groups by event_ticker

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

// Only drop the most obvious multi-leg parlay titles
function isSimpleMarket(m) {
    const t = m.title || '';
    // Multiple "yes X / no Y" condition segments = parlay
    if ((t.match(/\b(yes|no)\s+\S/gi) || []).length > 1) return false;
    // Extremely comma-heavy titles = combined market (7+ commas to be safe)
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

// Fetch event titles from /events endpoint (best-effort — fail silently)
async function fetchEventTitles() {
    const titleMap = {};
    try {
        let cursor = null;
        for (let page = 0; page < 3; page++) {
            const params = new URLSearchParams({ status: 'open', limit: '200' });
            if (cursor) params.set('cursor', cursor);
            const r = await fetch(`${KALSHI_BASE}/events?${params}`, {
                headers: getHeaders(),
                signal: AbortSignal.timeout(6000),
            });
            if (!r.ok) break;
            const d = await r.json();
            const events = d.events || [];
            events.forEach(e => {
                if (e.event_ticker && e.title) titleMap[e.event_ticker] = e.title;
            });
            cursor = d.cursor;
            if (!cursor || !events.length) break;
        }
    } catch (_) { /* fail silently — titles are supplementary */ }
    return titleMap;
}

// Fetch markets from /markets endpoint
async function fetchMarkets() {
    const all = [];
    let cursor = null;
    for (let page = 0; page < 2; page++) {
        const params = new URLSearchParams({ status: 'open', limit: '200' });
        if (cursor) params.set('cursor', cursor);
        const r = await fetch(`${KALSHI_BASE}/markets?${params}`, {
            headers: getHeaders(),
            signal: AbortSignal.timeout(7000),
        });
        if (!r.ok) {
            const body = await r.text().catch(() => '');
            throw new Error(`Kalshi ${r.status}: ${body.slice(0, 300)}`);
        }
        const d = await r.json();
        const markets = d.markets || [];
        all.push(...markets);
        cursor = d.cursor;
        if (!cursor || !markets.length) break;
    }
    return all;
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
        // Run both fetches in parallel; event titles are best-effort
        const [eventTitles, allRaw] = await Promise.all([
            fetchEventTitles(),
            fetchMarkets(),
        ]);

        // Filter out obvious multi-leg combo markets
        const filtered = allRaw.filter(isSimpleMarket);

        // Shape with event titles joined in
        const shaped = filtered.map(m => shapeMarket(m, eventTitles[m.event_ticker] || null));

        // Group by category
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

        // Absolute fallback: show everything in Other if categorization returns nothing
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
