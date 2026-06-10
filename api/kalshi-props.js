// Kalshi Mentions — mirrors kalshi.com/category/mentions
//
// Strategy (GET /events does NOT support a category param — that was the bug):
//   Round 1 (parallel):
//     a) GET /series/?category=Mentions  → authoritative list of mentions series
//     b) Paginated scan of GET /events?status=open (up to 4 pages) → title-match fallback
//   Round 2 (parallel):
//     For each relevant series: GET /events?series_ticker=X&with_nested_markets=true
//     For scan-found events not already covered: GET /markets?event_ticker=X
//
// Budget: Vercel Hobby 10s hard limit. Round 1 ≤4.5s, Round 2 ≤4s.

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

function getHeaders() {
    const key = process.env.KALSHI_API_KEY || '';
    return {
        'Authorization': key.startsWith('Bearer ') ? key : `Bearer ${key}`,
        'Accept': 'application/json',
    };
}

async function getJSON(url, timeoutMs) {
    try {
        const r = await fetch(url, { headers: getHeaders(), signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) return null;
        return await r.json();
    } catch (_) { return null; }
}

// ── Round 1a: series list for the Mentions category ────────────────────────
async function fetchMentionsSeries() {
    const d = await getJSON(`${KALSHI_BASE}/series/?category=Mentions`, 4500);
    return d?.series || [];
}

// ── Round 1b: paginated open-events scan, title-filtered as we go ──────────
const SAY_RE   = /\bsay\b|\bsays\b|\bsaid\b|\bsaying\b|\bmention/i;
const TRUMP_RE = /\btrump\b/i;
const SPORTS_RE = /baseball|basketball|hockey|football|soccer|\bnba\b|\bmlb\b|\bnhl\b|\bnfl\b|\bmls\b|announcer|tennis|golf|\bgame\b/i;

async function scanEventsForMentions() {
    const found = [];
    let cursor = null;
    const deadline = Date.now() + 4500;
    for (let page = 0; page < 4 && Date.now() < deadline; page++) {
        const qs = new URLSearchParams({ status: 'open', limit: '200' });
        if (cursor) qs.set('cursor', cursor);
        const d = await getJSON(`${KALSHI_BASE}/events?${qs}`, Math.max(1000, deadline - Date.now()));
        if (!d) break;
        (d.events || []).forEach(e => {
            const t = e.title || '';
            if (SAY_RE.test(t) || TRUMP_RE.test(t)) found.push(e);
        });
        cursor = d.cursor;
        if (!cursor || !(d.events || []).length) break;
    }
    return found;
}

// ── Round 2 fetchers ────────────────────────────────────────────────────────
async function fetchSeriesEvents(seriesTicker) {
    const qs = new URLSearchParams({
        status: 'open', limit: '10',
        series_ticker: seriesTicker,
        with_nested_markets: 'true',
    });
    const d = await getJSON(`${KALSHI_BASE}/events?${qs}`, 4000);
    return d?.events || [];
}

async function fetchEventMarkets(eventTicker) {
    const qs = new URLSearchParams({ status: 'open', limit: '50', event_ticker: eventTicker });
    const d = await getJSON(`${KALSHI_BASE}/markets?${qs}`, 4000);
    return d?.markets || [];
}

// ── Shaping ─────────────────────────────────────────────────────────────────
function toAmericanOdds(p) {
    if (p == null || p <= 0 || p >= 100) return null;
    const f = p / 100;
    return f >= 0.5 ? Math.round(-(f / (1 - f)) * 100) : Math.round(((1 - f) / f) * 100);
}

function shapeMarket(m) {
    return {
        ticker:       m.ticker,
        title:        m.yes_sub_title || m.subtitle || m.title || m.ticker,
        subtitle:     null,
        yesOdds:      toAmericanOdds(m.yes_ask ?? null),
        noOdds:       toAmericanOdds(m.no_ask  ?? null),
        yesPct:       m.yes_ask ?? null,
        noPct:        m.no_ask  ?? null,
        volume:       m.volume        || 0,
        openInterest: m.open_interest || 0,
        closeTime:    m.close_time    || null,
    };
}

function shapeEvent(event, rawMarkets) {
    const markets = (rawMarkets || []).map(shapeMarket).sort((a, b) => (b.volume || 0) - (a.volume || 0));
    if (!markets.length) return null;
    return {
        eventTicker: event.event_ticker,
        title:       event.title,
        closeTime:   event.close_time || markets[0].closeTime || null,
        total:       markets.length,
        markets:     markets.slice(0, 20),
    };
}

function isTrump(title) { return TRUMP_RE.test(title || ''); }
function isSports(title) { return SPORTS_RE.test(title || ''); }

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
        // Round 1
        const [mentionsSeries, scannedEvents] = await Promise.all([
            fetchMentionsSeries(),
            scanEventsForMentions(),
        ]);

        // Round 2a: events (with nested markets) for up to 10 mentions series
        const seriesToFetch = mentionsSeries.slice(0, 10);
        const seriesEventLists = await Promise.all(
            seriesToFetch.map(s => fetchSeriesEvents(s.ticker))
        );

        const events = [];           // { event, markets }
        const seenEvents = new Set();

        seriesEventLists.flat().forEach(e => {
            if (!e.event_ticker || seenEvents.has(e.event_ticker)) return;
            seenEvents.add(e.event_ticker);
            events.push({ event: e, markets: e.markets || [] });
        });

        // Round 2b: scanned events not already covered (cap 8 extra fetches)
        const extra = scannedEvents
            .filter(e => e.event_ticker && !seenEvents.has(e.event_ticker))
            .slice(0, 8);
        if (extra.length) {
            const extraMarkets = await Promise.all(extra.map(e => fetchEventMarkets(e.event_ticker)));
            extra.forEach((e, i) => {
                seenEvents.add(e.event_ticker);
                events.push({ event: e, markets: extraMarkets[i] });
            });
        }

        // Bucket: Trump first match wins, then sports, rest under Other
        const trumpEvents  = [];
        const sportsEvents = [];
        const otherEvents  = [];
        events.forEach(({ event, markets }) => {
            const shaped = shapeEvent(event, markets);
            if (!shaped) return;
            if (isTrump(event.title)) trumpEvents.push(shaped);
            else if (isSports(event.title)) sportsEvents.push(shaped);
            else otherEvents.push(shaped);
        });

        const categories = [];
        if (sportsEvents.length) categories.push({ id: 'sports', label: 'Sports — Announcer Mentions', events: sportsEvents });
        if (trumpEvents.length)  categories.push({ id: 'trump',  label: 'Politics — Trump Mentions',   events: trumpEvents });
        if (otherEvents.length)  categories.push({ id: 'other',  label: 'Other Mentions',              events: otherEvents });

        const total = categories.reduce((s, c) => s + c.events.reduce((es, ev) => es + ev.markets.length, 0), 0);

        res.status(200).json({
            categories, total,
            debug: {
                mentionsSeries: mentionsSeries.length,
                scannedEvents:  scannedEvents.length,
                eventsWithMarkets: events.length,
            },
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
