// Kalshi Mentions — mirrors the /category/mentions page
// Round 1: fetch events from Mentions + Sports + Politics categories
// Round 2: fetch markets per relevant event (parallel)
// Returns hierarchical: { categories: [{id, label, events: [{title, markets}]}] }

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

function getHeaders() {
    const key = process.env.KALSHI_API_KEY || '';
    return {
        'Authorization': key.startsWith('Bearer ') ? key : `Bearer ${key}`,
        'Accept': 'application/json',
    };
}

async function fetchEventsByCategory(category) {
    try {
        const url = `${KALSHI_BASE}/events?status=open&limit=200&category=${encodeURIComponent(category)}`;
        const r = await fetch(url, { headers: getHeaders(), signal: AbortSignal.timeout(5000) });
        if (!r.ok) return [];
        const d = await r.json();
        return d.events || [];
    } catch (_) { return []; }
}

async function fetchAllEvents() {
    try {
        const url = `${KALSHI_BASE}/events?status=open&limit=200`;
        const r = await fetch(url, { headers: getHeaders(), signal: AbortSignal.timeout(5000) });
        if (!r.ok) return [];
        const d = await r.json();
        return d.events || [];
    } catch (_) { return []; }
}

async function fetchEventMarkets(eventTicker) {
    try {
        const url = `${KALSHI_BASE}/markets?status=open&limit=50&event_ticker=${encodeURIComponent(eventTicker)}`;
        const r = await fetch(url, { headers: getHeaders(), signal: AbortSignal.timeout(4000) });
        if (!r.ok) return [];
        const d = await r.json();
        return d.markets || [];
    } catch (_) { return []; }
}

function toAmericanOdds(p) {
    if (p == null || p <= 0 || p >= 100) return null;
    const f = p / 100;
    return f >= 0.5 ? Math.round(-(f / (1 - f)) * 100) : Math.round(((1 - f) / f) * 100);
}

function shape(m) {
    return {
        ticker:       m.ticker,
        title:        m.title || m.subtitle || m.ticker,
        subtitle:     m.subtitle || null,
        yesOdds:      toAmericanOdds(m.yes_ask ?? null),
        noOdds:       toAmericanOdds(m.no_ask  ?? null),
        yesPct:       m.yes_ask ?? null,
        noPct:        m.no_ask  ?? null,
        volume:       m.volume        || 0,
        openInterest: m.open_interest || 0,
        closeTime:    m.close_time    || null,
    };
}

// A "mentions" event talks about what someone will SAY
const SAY_RE     = /\bsay\b|\bsays\b|\bsaid\b|\bsaying\b|\bmention\b|\bannouncer/i;
const SPORTS_RE  = /baseball|basketball|hockey|football|soccer|\bnba\b|\bmlb\b|\bnhl\b|\bnfl\b|\bmls\b|game|sport|announcer|tennis|golf/i;
const TRUMP_RE   = /\btrump\b/i;

function isSportsEvent(e) {
    const t = e.title || '';
    return SAY_RE.test(t) && SPORTS_RE.test(t);
}
function isTrumpEvent(e) {
    return TRUMP_RE.test(e.title || '');
}
function isMentionsEvent(e) {
    return SAY_RE.test(e.title || '');
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=15');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!process.env.KALSHI_API_KEY) {
        return res.status(200).json({
            categories: [], total: 0,
            error: 'KALSHI_API_KEY not set — add it in Vercel → Project Settings → Environment Variables',
            fetchedAt: new Date().toISOString(),
        });
    }

    try {
        // Round 1: fetch events from multiple categories in parallel
        const [mentionsEvents, sportsEvents, politicsEvents, allEvents] = await Promise.all([
            fetchEventsByCategory('Mentions'),
            fetchEventsByCategory('Sports'),
            fetchEventsByCategory('Politics'),
            fetchAllEvents(),
        ]);

        // Merge + deduplicate
        const seenTickers = new Set();
        const combined = [...mentionsEvents, ...sportsEvents, ...politicsEvents, ...allEvents]
            .filter(e => {
                if (!e.event_ticker || seenTickers.has(e.event_ticker)) return false;
                seenTickers.add(e.event_ticker);
                return true;
            });

        // Separate into sports mentions and Trump mentions
        let sportsBucket = combined.filter(isSportsEvent);
        let trumpBucket  = combined.filter(isTrumpEvent);

        // If no SAY-style sports events found, fall back to all mentions events
        if (!sportsBucket.length) {
            sportsBucket = combined.filter(e => isMentionsEvent(e) && !TRUMP_RE.test(e.title || ''));
        }

        // Cap to keep within Vercel time budget: 7 sports + 5 trump = 12 parallel market fetches × 4s = 4s
        const sportsToFetch = sportsBucket.slice(0, 7);
        const trumpToFetch  = trumpBucket.slice(0, 5);
        const allToFetch    = [...sportsToFetch, ...trumpToFetch];

        if (!allToFetch.length) {
            return res.status(200).json({
                categories: [], total: 0,
                fetchedAt: new Date().toISOString(),
            });
        }

        // Round 2: fetch markets for each event in parallel
        const marketResults = await Promise.all(allToFetch.map(e => fetchEventMarkets(e.event_ticker)));

        function buildCategory(id, label, events, offset) {
            const catEvents = events
                .map((event, i) => {
                    const raw     = marketResults[offset + i] || [];
                    const markets = raw.map(shape).sort((a, b) => (b.volume || 0) - (a.volume || 0));
                    if (!markets.length) return null;
                    return {
                        eventTicker: event.event_ticker,
                        title:       event.title,
                        closeTime:   event.close_time || null,
                        total:       raw.length,         // real total from Kalshi
                        markets:     markets.slice(0, 15), // show top 15 per event
                    };
                })
                .filter(Boolean);
            return catEvents.length ? { id, label, events: catEvents } : null;
        }

        const sportsCategory = buildCategory('sports', '🏀 Sports · Announcer Mentions', sportsToFetch, 0);
        const trumpCategory  = buildCategory('trump',  '🏛️ Trump Mentions',               trumpToFetch,  sportsToFetch.length);

        const categories = [sportsCategory, trumpCategory].filter(Boolean);
        const total = categories.reduce((s, c) => s + c.events.reduce((es, ev) => es + ev.markets.length, 0), 0);

        res.status(200).json({ categories, total, fetchedAt: new Date().toISOString() });
    } catch (err) {
        res.status(200).json({
            categories: [], total: 0,
            error: err.message,
            fetchedAt: new Date().toISOString(),
        });
    }
};
