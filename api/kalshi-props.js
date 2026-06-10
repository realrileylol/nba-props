// Kalshi Mentions — mirrors kalshi.com/category/mentions
//
// Key facts learned from production debug:
//   - /series/?category=Mentions returns ~367 series (authoritative mentions list)
//   - Mentions markets are status "unopened" until shortly before each broadcast,
//     so a status=open market filter wrongly returns nothing during the day.
//   - Kalshi rate-limits ~10 reads/sec — bulk concurrency must stay small.
//   - The paginated open-events scan is NON-DETERMINISTIC: which mentions events
//     land inside the 1000-event window varies per request, which made every
//     Refresh return a different list. The scan is now only a supplement.
//   - Vercel Hobby kills functions at 10s — total budget here is ~8s worst case.
//
// Flow:
//   Round 1 (parallel): series list + open-events scan (supplement only)
//   Backbone: the major series (NBA, MLB, NHL, NFL, Trump, press…) are fetched
//             DIRECTLY by series_ticker in rate-limited waves — deterministic,
//             same core results on every refresh
//   Tagging:  every series gets a league/topic tag (NBA, MLB, Trump, …) which
//             drives both the category tab and the sub-category tab

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
    const d = await getJSON(`${KALSHI_BASE}/series/?category=Mentions`, 4000);
    return d?.series || [];
}

// Supplemental open-events scan (nested markets). Non-deterministic window —
// only ADDS events beyond the deterministic backbone, never the main source.
async function scanOpenEvents() {
    const all = [];
    let cursor = null;
    const deadline = Date.now() + 3500;
    for (let page = 0; page < 5 && Date.now() < deadline - 300; page++) {
        const qs = new URLSearchParams({
            status: 'open',
            limit: '200',
            with_nested_markets: 'true',
        });
        if (cursor) qs.set('cursor', cursor);
        const d = await getJSON(`${KALSHI_BASE}/events?${qs}`, Math.max(800, deadline - Date.now()));
        if (!d) break;
        all.push(...(d.events || []));
        cursor = d.cursor;
        if (!cursor || !(d.events || []).length) break;
    }
    return all;
}

// Deterministic per-series events fetch (nested markets, open only)
async function fetchSeriesEvents(seriesTicker) {
    const qs = new URLSearchParams({
        limit: '20',
        status: 'open',
        series_ticker: seriesTicker,
        with_nested_markets: 'true',
    });
    const d = await getJSON(`${KALSHI_BASE}/events?${qs}`, 2500);
    return d?.events || [];
}

// Rate-limit-safe: fetch series events in sequential waves of `size` parallel calls
async function fetchSeriesInWaves(tickers, size) {
    const out = [];
    for (let i = 0; i < tickers.length; i += size) {
        const wave = await Promise.all(tickers.slice(i, i + size).map(t => fetchSeriesEvents(t)));
        out.push(...wave.flat());
    }
    return out;
}

// Direct market fetch for one event — /markets always carries live price
// fields, used to hydrate events whose nested markets came back price-less
async function fetchEventMarkets(eventTicker) {
    const qs = new URLSearchParams({ limit: '60', event_ticker: eventTicker });
    const d = await getJSON(`${KALSHI_BASE}/markets?${qs}`, 2000);
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

// ── Tagging ──────────────────────────────────────────────────────────────
// Every mentions series gets one league/topic tag. The tag drives both the
// top-level category tab and the sub-category tab in the UI.
function tagForSeries(ticker, title) {
    const s = `${ticker || ''} ${title || ''}`;
    if (/wnba/i.test(s))                                  return 'WNBA';
    if (/nba|basketball/i.test(s))                        return 'NBA';
    if (/mlb|baseball/i.test(s))                          return 'MLB';
    if (/nhl|hockey/i.test(s))                            return 'NHL';
    if (/nfl/i.test(s))                                   return 'NFL';
    if (/soccer|premier|fifa|\bmls\b|champions/i.test(s)) return 'Soccer';
    if (/golf|pga|masters/i.test(s))                      return 'Golf';
    if (/tennis|wimbledon/i.test(s))                      return 'Tennis';
    if (/nascar|\bf1\b|grand prix|racing/i.test(s))       return 'Racing';
    if (/ufc|boxing|mma/i.test(s))                        return 'Combat';
    if (/football|announcer|sport/i.test(s))              return 'Sports';
    if (/trump/i.test(s))                                 return 'Trump';
    if (/press|briefing|white house|leavitt/i.test(s))    return 'Press';
    if (/biden|vance|musk|congress|senate|governor|mayor|debate|politic|cabinet|powell|fed/i.test(s)) return 'Politics';
    return 'Other';
}

const SPORT_TAGS     = new Set(['NBA', 'WNBA', 'MLB', 'NHL', 'NFL', 'Soccer', 'Golf', 'Tennis', 'Racing', 'Combat', 'Sports']);
const POLITICAL_TAGS = new Set(['Trump', 'Press', 'Politics']);

function categoryForTag(tag) {
    if (SPORT_TAGS.has(tag))     return 'sports';
    if (POLITICAL_TAGS.has(tag)) return 'political';
    return 'other';
}

// Backbone fetch priority — these series are fetched directly every request,
// so the core of every refresh is identical
const TAG_PRIORITY = ['NBA', 'MLB', 'NHL', 'NFL', 'WNBA', 'Soccer', 'Golf', 'Tennis', 'Racing', 'Combat', 'Sports', 'Trump', 'Press', 'Politics'];
function tagPriority(tag) {
    const i = TAG_PRIORITY.indexOf(tag);
    return i === -1 ? 99 : i;
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
        // Round 1 — series list + supplemental scan, in parallel
        const [mentionsSeries, openEvents] = await Promise.all([
            fetchMentionsSeries(),
            scanOpenEvents(),
        ]);

        const tagBySeries = new Map(
            mentionsSeries.map(s => [s.ticker, tagForSeries(s.ticker, s.title)]));
        const mentionTickers = new Set(mentionsSeries.map(s => s.ticker).filter(Boolean));

        // Deterministic backbone: top-priority series fetched directly, in a
        // STABLE order (priority, then ticker) so every refresh hits the same set
        const backbone = mentionsSeries
            .filter(s => s.ticker && tagPriority(tagBySeries.get(s.ticker)) < 99)
            .sort((a, b) =>
                tagPriority(tagBySeries.get(a.ticker)) - tagPriority(tagBySeries.get(b.ticker)) ||
                (a.ticker < b.ticker ? -1 : 1))
            .slice(0, 16);

        // Two waves of 8 parallel calls — under Kalshi's ~10 req/s limit
        const backboneEvents = await fetchSeriesInWaves(backbone.map(s => s.ticker), 8);

        // Merge: backbone first (stable core), then scan extras
        const merged = new Map();
        backboneEvents.forEach(e => {
            if (e.event_ticker) merged.set(e.event_ticker, e);
        });
        openEvents.forEach(e => {
            if (e.event_ticker && !merged.has(e.event_ticker) &&
                e.series_ticker && mentionTickers.has(e.series_ticker)) {
                merged.set(e.event_ticker, e);
            }
        });

        // Price hydration — if an event's nested markets all came back without
        // price fields, re-fetch them from /markets (which always has prices).
        // Soonest-closing first, capped at 4 parallel calls.
        const needsPrices = [...merged.values()]
            .filter(e => (e.markets || []).length && !e.markets.some(hasAnyPrice))
            .sort((a, b) => new Date(a.close_time || 8.64e15) - new Date(b.close_time || 8.64e15))
            .slice(0, 4);
        const hydrated = await Promise.all(needsPrices.map(e => fetchEventMarkets(e.event_ticker)));
        needsPrices.forEach((e, i) => { if (hydrated[i].length) e.markets = hydrated[i]; });

        // Bucket into category tabs; each event carries its sub-category tag
        const buckets = { sports: [], political: [], other: [] };
        merged.forEach(event => {
            const shaped = shapeEvent(event, event.markets);
            if (!shaped) return;
            const tag = tagBySeries.get(event.series_ticker) || 'Other';
            shaped.tag = tag;
            buckets[categoryForTag(tag)].push(shaped);
        });

        // Deterministic ordering inside every bucket
        const byClose = (a, b) =>
            new Date(a.closeTime || 8.64e15) - new Date(b.closeTime || 8.64e15) ||
            (a.eventTicker < b.eventTicker ? -1 : 1);
        Object.values(buckets).forEach(arr => arr.sort(byClose));

        const categories = [];
        if (buckets.sports.length)    categories.push({ id: 'sports',    label: 'Sports',    events: buckets.sports });
        if (buckets.political.length) categories.push({ id: 'political', label: 'Political', events: buckets.political });
        if (buckets.other.length)     categories.push({ id: 'other',     label: 'All Other', events: buckets.other });

        const total = categories.reduce((s, c) => s + c.events.reduce((es, ev) => es + ev.markets.length, 0), 0);

        res.status(200).json({
            categories, total,
            debug: {
                mentionsSeries:    mentionsSeries.length,
                backboneSeries:    backbone.length,
                backboneEvents:    backboneEvents.length,
                openEventsScanned: openEvents.length,
                merged:            merged.size,
                hydratedEvents:    needsPrices.length,
                withMarkets:       categories.reduce((s, c) => s + c.events.length, 0),
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
