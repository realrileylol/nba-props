// Kalshi Mentions — mirrors kalshi.com/category/mentions
//
// Key facts learned from production debug:
//   - /series/?category=Mentions returns ~367 series (authoritative mentions list)
//   - Mentions markets are status "unopened" until shortly before each broadcast,
//     so a status=open market filter wrongly returns nothing during the day.
//   - Kalshi rate-limits ~10 reads/sec — per-event market fetches DO NOT scale.
//     Instead, the events scan uses with_nested_markets=true so markets arrive
//     inside the same paginated calls (~5 requests total instead of ~58).
//   - Vercel Hobby kills functions at 10s — total budget here is ~8s worst case.
//
// Flow:
//   Round 1 (parallel): series list + paginated open-events scan WITH nested markets
//   Match:  events whose series_ticker is in the Mentions series set (strict —
//           no title-regex fallback, which leaked non-mentions markets in)
//   Round 2 (parallel, ≤8 calls): sports-flavored series fetched directly so
//           tonight's game always appears even past the pagination window

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

async function fetchMentionsSeries() {
    const d = await getJSON(`${KALSHI_BASE}/series/?category=Mentions`, 4500);
    return d?.series || [];
}

// Paginated open-events scan with nested markets — one batch of calls returns
// every open event AND its full market list (markets are NOT status-filtered,
// so "unopened" mentions markets are included)
async function scanOpenEvents() {
    const all = [];
    let cursor = null;
    const deadline = Date.now() + 4500;
    for (let page = 0; page < 5 && Date.now() < deadline - 300; page++) {
        const qs = new URLSearchParams({
            status: 'open',
            limit: '200',
            with_nested_markets: 'true',
        });
        if (cursor) qs.set('cursor', cursor);
        const d = await getJSON(`${KALSHI_BASE}/events?${qs}`, Math.max(900, deadline - Date.now()));
        if (!d) break;
        all.push(...(d.events || []));
        cursor = d.cursor;
        if (!cursor || !(d.events || []).length) break;
    }
    return all;
}

// Events (with nested markets) for one series — guarantees we find live game
// events even when they're beyond the events-scan pagination window.
// status=open here too, otherwise past (settled) games come back.
async function fetchSeriesEvents(seriesTicker) {
    const qs = new URLSearchParams({
        limit: '10',
        status: 'open',
        series_ticker: seriesTicker,
        with_nested_markets: 'true',
    });
    const d = await getJSON(`${KALSHI_BASE}/events?${qs}`, 3000);
    return d?.events || [];
}

// Direct market fetch for one event — /markets always carries live price
// fields, used to hydrate events whose nested markets came back price-less
async function fetchEventMarkets(eventTicker) {
    const qs = new URLSearchParams({ limit: '60', event_ticker: eventTicker });
    const d = await getJSON(`${KALSHI_BASE}/markets?${qs}`, 2500);
    return d?.markets || [];
}

function toAmericanOdds(p) {
    if (p == null || p <= 0 || p >= 100) return null;
    const f = p / 100;
    return f >= 0.5 ? Math.round(-(f / (1 - f)) * 100) : Math.round(((1 - f) / f) * 100);
}

function validPct(p) { return p != null && p > 0 && p < 100 ? p : null; }

function hasAnyPrice(m) {
    return validPct(m.yes_ask) != null || validPct(m.yes_bid) != null ||
           validPct(m.last_price) != null || validPct(m.previous_yes_price) != null;
}

function shapeMarket(m) {
    // Try every known price field in priority order: live ask → bid → last trade → prev close
    const yesPct = validPct(m.yes_ask)
        ?? validPct(m.yes_bid)
        ?? validPct(m.last_price)
        ?? validPct(m.previous_yes_price);
    const noPct  = validPct(m.no_ask)
        ?? validPct(m.no_bid)
        ?? (yesPct != null ? 100 - yesPct : null);
    return {
        ticker:       m.ticker,
        title:        m.yes_sub_title || m.subtitle || m.title || m.ticker,
        subtitle:     null,
        status:       m.status || null,          // 'open' | 'unopened' | ...
        yesOdds:      toAmericanOdds(yesPct),
        noOdds:       toAmericanOdds(noPct),
        yesPct,
        noPct,
        volume:       m.volume        || 0,
        openInterest: m.open_interest || 0,
        closeTime:    m.close_time    || null,
    };
}

function shapeEvent(event, rawMarkets) {
    const now = Date.now();
    const usable = (rawMarkets || []).filter(m =>
        m.status !== 'settled' && m.status !== 'closed' && m.status !== 'finalized' &&
        (!m.close_time || new Date(m.close_time).getTime() > now));
    const markets = usable.map(shapeMarket).sort((a, b) => {
        const ao = a.status === 'open' ? 0 : 1;
        const bo = b.status === 'open' ? 0 : 1;
        return ao - bo || (b.volume || 0) - (a.volume || 0);
    });
    if (!markets.length) return null;
    const closeTime = event.close_time || markets[0].closeTime || null;
    // Drop events that already closed — nothing left to bet on
    if (closeTime && new Date(closeTime).getTime() <= now) return null;
    return {
        eventTicker: event.event_ticker,
        title:       event.title,
        closeTime,
        total:       markets.length,
        markets:     markets.slice(0, 40),
    };
}

// Categorize by series + event text — every event lands in exactly one tab
const SPORTS_RE = /baseball|basketball|hockey|football|soccer|\bnba\b|\bmlb\b|\bnhl\b|\bnfl\b|\bmls\b|\bwnba\b|announcer|tennis|golf|nascar|ufc|boxing|olympic|\bvs\.?\b|\bgame\b|series|finals|playoff/i;
const POLITICAL_RE = /trump|biden|vance|white house|press (briefing|secretary|conference)|congress|senate|house speaker|governor|mayor|politic|debate|state of the union|cabinet|leavitt|fed chair|powell/i;

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
        // Round 1 — series list + full open-events scan (markets nested)
        const [mentionsSeries, openEvents] = await Promise.all([
            fetchMentionsSeries(),
            scanOpenEvents(),
        ]);

        const mentionTickers = new Set(mentionsSeries.map(s => s.ticker).filter(Boolean));
        const seriesTitleByTicker = new Map(mentionsSeries.map(s => [s.ticker, s.title || '']));

        // STRICT match: only events whose series is in the Mentions category.
        // (The old title-regex fallback leaked unrelated markets like
        // "Will there be a Trump economic boom?" into the list.)
        const mentionEvents = openEvents.filter(e =>
            e.series_ticker && mentionTickers.has(e.series_ticker));

        // Round 2 — sports series fetched directly so live game events always
        // appear even if the scan's pagination window missed them (≤8 calls)
        const SPORT_SERIES_RE = /nba|basketball|mlb|baseball|nhl|hockey|nfl|football|announcer|finals/i;
        const sportSeries = mentionsSeries
            .filter(s => SPORT_SERIES_RE.test(`${s.ticker || ''} ${s.title || ''}`))
            .slice(0, 8);
        const seriesEventLists = await Promise.all(
            sportSeries.map(s => fetchSeriesEvents(s.ticker)));

        // Merge by event_ticker — all events carry nested markets
        const merged = new Map();
        mentionEvents.forEach(e => {
            if (e.event_ticker) merged.set(e.event_ticker, e);
        });
        seriesEventLists.flat().forEach(e => {
            if (e.event_ticker && !merged.has(e.event_ticker)) merged.set(e.event_ticker, e);
        });

        // Price hydration — if an event's nested markets all came back without
        // price fields, re-fetch them from /markets (which always has prices).
        // Soonest-closing first, capped at 6 parallel calls (under rate limit).
        const needsPrices = [...merged.values()]
            .filter(e => (e.markets || []).length && !e.markets.some(hasAnyPrice))
            .sort((a, b) => new Date(a.close_time || 8.64e15) - new Date(b.close_time || 8.64e15))
            .slice(0, 6);
        const hydrated = await Promise.all(needsPrices.map(e => fetchEventMarkets(e.event_ticker)));
        needsPrices.forEach((e, i) => { if (hydrated[i].length) e.markets = hydrated[i]; });

        // Bucket every event into exactly one category tab
        const sportsEvents    = [];
        const politicalEvents = [];
        const otherEvents     = [];
        merged.forEach(event => {
            const shaped = shapeEvent(event, event.markets);
            if (!shaped) return;
            const text = `${event.title || ''} ${seriesTitleByTicker.get(event.series_ticker) || ''}`;
            if (SPORTS_RE.test(text))         sportsEvents.push(shaped);
            else if (POLITICAL_RE.test(text)) politicalEvents.push(shaped);
            else                              otherEvents.push(shaped);
        });

        const categories = [];
        if (sportsEvents.length)    categories.push({ id: 'sports',    label: 'Sports',    events: sportsEvents });
        if (politicalEvents.length) categories.push({ id: 'political', label: 'Political', events: politicalEvents });
        if (otherEvents.length)     categories.push({ id: 'other',     label: 'All Other', events: otherEvents });

        const total = categories.reduce((s, c) => s + c.events.reduce((es, ev) => es + ev.markets.length, 0), 0);

        // Sample the first few raw nested-market objects so we can see
        // which price fields Kalshi actually returns in this format.
        const rawSample = [...merged.values()].flatMap(e => e.markets || []).slice(0, 3).map(m => ({
            ticker: m.ticker,
            status: m.status,
            yes_ask: m.yes_ask,
            yes_bid: m.yes_bid,
            no_ask:  m.no_ask,
            no_bid:  m.no_bid,
            last_price: m.last_price,
            previous_yes_price: m.previous_yes_price,
        }));

        res.status(200).json({
            categories, total,
            debug: {
                mentionsSeries:    mentionsSeries.length,
                sportSeries:       sportSeries.length,
                openEventsScanned: openEvents.length,
                mentionEvents:     mentionEvents.length,
                merged:            merged.size,
                withMarkets:       categories.reduce((s, c) => s + c.events.length, 0),
                hydratedEvents:    needsPrices.length,
                rawSample,
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
