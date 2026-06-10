// Kalshi Mentions — mirrors kalshi.com/category/mentions
//
// Architecture (3 phases, all deterministic):
//   Phase 1: GET /series/?category=Mentions → tagged list of all ~367 series
//   Phase 2: For each backbone series (by tag priority), fetch open events
//            (lightweight — no nested markets, just metadata)
//   Phase 3: For the top N events per tag, fetch /markets?event_ticker=X
//            This endpoint ALWAYS returns real price fields. No nested-market
//            price-stripping problem.
//
// Vercel Hobby 10s kill — budgets: phase1≤3s, phase2≤2.5s, phase3≤2.5s

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

// Phase 1
async function fetchMentionsSeries() {
    const d = await getJSON(`${KALSHI_BASE}/series/?category=Mentions`, 3000);
    return d?.series || [];
}

// Phase 2 — events only, no nested markets (fast)
async function fetchSeriesEvents(seriesTicker) {
    const qs = new URLSearchParams({ limit: '10', status: 'open', series_ticker: seriesTicker });
    const d = await getJSON(`${KALSHI_BASE}/events?${qs}`, 2000);
    return (d?.events || []).map(e => ({ ...e, series_ticker: e.series_ticker || seriesTicker }));
}

// Phase 3 — /markets always has real price fields
async function fetchEventMarkets(eventTicker) {
    const qs = new URLSearchParams({ limit: '60', event_ticker: eventTicker });
    const d = await getJSON(`${KALSHI_BASE}/markets?${qs}`, 2000);
    return d?.markets || [];
}

// ── Tags ─────────────────────────────────────────────────────────────────────
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
    if (/sport|announcer|football/i.test(s))              return 'Sports';
    if (/trump/i.test(s))                                 return 'Trump';
    if (/press|briefing|white house|leavitt/i.test(s))    return 'Press';
    if (/biden|vance|musk|congress|senate|governor|mayor|debate|politic|cabinet|powell|fed/i.test(s)) return 'Politics';
    return 'Other';
}

const SPORT_TAGS     = new Set(['NBA','WNBA','MLB','NHL','NFL','Soccer','Golf','Tennis','Racing','Combat','Sports']);
const POLITICAL_TAGS = new Set(['Trump','Press','Politics']);

function categoryForTag(tag) {
    if (SPORT_TAGS.has(tag))     return 'sports';
    if (POLITICAL_TAGS.has(tag)) return 'political';
    return 'other';
}

const TAG_ORDER = ['NBA','MLB','NHL','NFL','WNBA','Soccer','Golf','Tennis','Racing','Combat','Sports','Trump','Press','Politics','Other'];
function tagPriority(tag) { const i = TAG_ORDER.indexOf(tag); return i === -1 ? 99 : i; }

// ── Price helpers ─────────────────────────────────────────────────────────────
function toAmericanOdds(p) {
    if (p == null || p <= 0 || p >= 100) return null;
    const f = p / 100;
    return f >= 0.5 ? Math.round(-(f / (1 - f)) * 100) : Math.round(((1 - f) / f) * 100);
}

function validPct(p) { return p != null && p > 0 && p < 100 ? p : null; }

function shapeMarket(m) {
    const yesPct = validPct(m.yes_ask) ?? validPct(m.yes_bid) ?? validPct(m.last_price) ?? validPct(m.previous_yes_price);
    const noPct  = validPct(m.no_ask)  ?? validPct(m.no_bid)  ?? (yesPct != null ? 100 - yesPct : null);
    return {
        ticker:       m.ticker,
        title:        m.yes_sub_title || m.subtitle || m.title || m.ticker,
        status:       m.status || null,
        yesOdds:      toAmericanOdds(yesPct),
        noOdds:       toAmericanOdds(noPct),
        yesPct,
        noPct,
        volume:       m.volume        || 0,
        openInterest: m.open_interest || 0,
        closeTime:    m.close_time    || null,
    };
}

const TOP_PER_TAG      = 5;   // max events shown per sub-category (league/topic)
const MAX_MKT_FETCHES  = 12;  // max parallel /markets requests (rate-limit safe)

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=15');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!process.env.KALSHI_API_KEY) {
        return res.status(200).json({
            categories: [], total: 0,
            error: 'KALSHI_API_KEY not set',
            fetchedAt: new Date().toISOString(),
        });
    }

    try {
        // ── Phase 1: series list ─────────────────────────────────────────────
        const mentionsSeries = await fetchMentionsSeries();
        const tagBySeries    = new Map(mentionsSeries.map(s => [s.ticker, tagForSeries(s.ticker, s.title)]));

        // Backbone: all tagged series sorted by priority (stable order every request)
        const backbone = mentionsSeries
            .filter(s => s.ticker && tagPriority(tagBySeries.get(s.ticker)) < 99)
            .sort((a, b) =>
                tagPriority(tagBySeries.get(a.ticker)) - tagPriority(tagBySeries.get(b.ticker)) ||
                (a.ticker < b.ticker ? -1 : 1))
            .slice(0, 20);

        // ── Phase 2: open events for backbone series (parallel, no markets) ──
        const seriesEventGroups = await Promise.all(
            backbone.map(s => fetchSeriesEvents(s.ticker)));

        // Collect top N events per tag (soonest closing = most relevant today)
        const topByTag = {};
        backbone.forEach((s, i) => {
            const tag    = tagBySeries.get(s.ticker);
            const events = seriesEventGroups[i] || [];
            if (!topByTag[tag]) topByTag[tag] = [];
            topByTag[tag].push(...events.map(e => ({ ...e, _tag: tag })));
        });

        const now = Date.now();
        Object.keys(topByTag).forEach(tag => {
            // Deduplicate, drop past events, sort soonest-closing first, keep top N
            const seen = new Set();
            topByTag[tag] = topByTag[tag]
                .filter(e => {
                    if (!e.event_ticker || seen.has(e.event_ticker)) return false;
                    if (e.close_time && new Date(e.close_time).getTime() <= now) return false;
                    seen.add(e.event_ticker);
                    return true;
                })
                .sort((a, b) => new Date(a.close_time || 8.64e15) - new Date(b.close_time || 8.64e15))
                .slice(0, TOP_PER_TAG);
        });

        // All events we'll actually show, in priority order
        const allEvents = TAG_ORDER
            .flatMap(tag => topByTag[tag] || [])
            .slice(0, MAX_MKT_FETCHES);

        // ── Phase 3: real prices for each event from /markets endpoint ───────
        const marketGroups = await Promise.all(allEvents.map(e => fetchEventMarkets(e.event_ticker)));

        // Shape and bucket
        const buckets = { sports: [], political: [], other: [] };
        allEvents.forEach((event, i) => {
            const rawMarkets = marketGroups[i] || [];
            const usable = rawMarkets.filter(m =>
                m.status !== 'settled' && m.status !== 'closed' && m.status !== 'finalized' &&
                (!m.close_time || new Date(m.close_time).getTime() > now));
            const markets = usable.map(shapeMarket).sort((a, b) => {
                const ao = a.status === 'open' ? 0 : 1;
                const bo = b.status === 'open' ? 0 : 1;
                return ao - bo || (b.volume || 0) - (a.volume || 0);
            });
            if (!markets.length) return;
            const tag      = event._tag;
            const catId    = categoryForTag(tag);
            const closeTime = event.close_time || markets[0].closeTime || null;
            if (closeTime && new Date(closeTime).getTime() <= now) return;
            buckets[catId].push({
                eventTicker: event.event_ticker,
                title:       event.title,
                tag,
                closeTime,
                total:       markets.length,
                markets:     markets.slice(0, 40),
            });
        });

        const categories = [];
        if (buckets.sports.length)    categories.push({ id: 'sports',    label: 'Sports',    events: buckets.sports });
        if (buckets.political.length) categories.push({ id: 'political', label: 'Political', events: buckets.political });
        if (buckets.other.length)     categories.push({ id: 'other',     label: 'All Other', events: buckets.other });

        const total = categories.reduce((s, c) => s + c.events.reduce((es, ev) => es + ev.markets.length, 0), 0);

        res.status(200).json({
            categories, total,
            debug: {
                mentionsSeries: mentionsSeries.length,
                backbone:       backbone.length,
                eventsFetched:  allEvents.length,
                withMarkets:    categories.reduce((s, c) => s + c.events.length, 0),
            },
            fetchedAt: new Date().toISOString(),
        });
    } catch (err) {
        res.status(200).json({ categories: [], total: 0, error: err.message, fetchedAt: new Date().toISOString() });
    }
};
