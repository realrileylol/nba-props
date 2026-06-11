// Kalshi Mentions
//
// What works (confirmed): paginated open-events scan returns mentions events fine.
// What broke: per-series fetches return empty (Kalshi likely ignores series_ticker
// on the events endpoint or requires different params). Back to the scan.
//
// Architecture:
//   Phase 1 (parallel): series list + open-events scan (no nested markets — fast)
//   Phase 2:            /markets?event_ticker=X for top 8 events — always has prices
//   Cache:              30s warm-instance cache; stale fallback on error/empty
//
// Vercel 10s budget: ~3s scan + ~2s market fetches = ~5s. Plenty of margin.

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

// Scan open events WITHOUT nested markets — small payloads, reliably fast
async function scanOpenEvents() {
    const all = [];
    let cursor = null;
    const deadline = Date.now() + 4000;
    for (let page = 0; page < 6 && Date.now() < deadline - 400; page++) {
        const qs = new URLSearchParams({ status: 'open', limit: '200' });
        if (cursor) qs.set('cursor', cursor);
        const d = await getJSON(
            `${KALSHI_BASE}/events?${qs}`,
            Math.max(800, deadline - Date.now())
        );
        if (!d) break;
        all.push(...(d.events || []));
        cursor = d.cursor;
        if (!cursor || !(d.events || []).length) break;
    }
    return all;
}

// /markets always returns real price fields (unlike nested market format)
async function fetchEventMarkets(eventTicker) {
    const qs = new URLSearchParams({ limit: '60', event_ticker: eventTicker });
    const d = await getJSON(`${KALSHI_BASE}/markets?${qs}`, 2500);
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
        yesPct, noPct,
        volume:       m.volume        || 0,
        openInterest: m.open_interest || 0,
        closeTime:    m.close_time    || null,
    };
}

// 30s warm-instance cache — rapid refreshes never re-hit Kalshi
let _cache = { data: null, ts: 0 };
const CACHE_MS = 30_000;

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=15');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!process.env.KALSHI_API_KEY) {
        return res.status(200).json({ categories: [], total: 0,
            error: 'KALSHI_API_KEY not set', fetchedAt: new Date().toISOString() });
    }

    // Serve warm cache — no Kalshi hit needed
    if (_cache.data && Date.now() - _cache.ts < CACHE_MS) {
        return res.status(200).json({ ..._cache.data, cached: true });
    }

    try {
        // ── Phase 1: series list + event scan in parallel ─────────────────────
        const [mentionsSeries, openEvents] = await Promise.all([
            fetchMentionsSeries(),
            scanOpenEvents(),
        ]);

        const mentionTickers = new Set(mentionsSeries.map(s => s.ticker).filter(Boolean));
        const tagBySeries    = new Map(mentionsSeries.map(s => [s.ticker, tagForSeries(s.ticker, s.title)]));

        const now = Date.now();

        // Filter scan results to mentions events only; drop already-closed events
        const mentionEvents = openEvents.filter(e =>
            e.series_ticker && mentionTickers.has(e.series_ticker) &&
            (!e.close_time || new Date(e.close_time).getTime() > now)
        );

        // Tag each event and sort by close time (soonest = most relevant today)
        const tagged = mentionEvents.map(e => ({
            ...e,
            _tag: tagBySeries.get(e.series_ticker) || 'Other',
        })).sort((a, b) =>
            new Date(a.close_time || 8.64e15) - new Date(b.close_time || 8.64e15)
        );

        // Take top 3 per tag across priority order, cap at 8 total market fetches
        const seen = new Set();
        const countByTag = {};
        const toFetch = [];
        for (const tag of TAG_ORDER) {
            for (const e of tagged.filter(x => x._tag === tag)) {
                if (seen.has(e.event_ticker)) continue;
                if ((countByTag[tag] || 0) >= 3) continue;
                seen.add(e.event_ticker);
                countByTag[tag] = (countByTag[tag] || 0) + 1;
                toFetch.push(e);
                if (toFetch.length >= 8) break;
            }
            if (toFetch.length >= 8) break;
        }

        // ── Phase 2: market prices in parallel (always has price fields) ──────
        const marketGroups = await Promise.all(toFetch.map(e => fetchEventMarkets(e.event_ticker)));

        // Shape and bucket
        const buckets = { sports: [], political: [], other: [] };
        toFetch.forEach((event, i) => {
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
            const closeTime = event.close_time || markets[0]?.closeTime || null;
            if (closeTime && new Date(closeTime).getTime() <= now) return;
            buckets[categoryForTag(event._tag)].push({
                eventTicker: event.event_ticker,
                title:       event.title,
                tag:         event._tag,
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
        const payload = {
            categories, total,
            debug: {
                mentionsSeries:    mentionsSeries.length,
                openEventsScanned: openEvents.length,
                mentionEvents:     mentionEvents.length,
                eventsFetched:     toFetch.length,
                withMarkets:       categories.reduce((s, c) => s + c.events.length, 0),
            },
            fetchedAt: new Date().toISOString(),
        };

        // Cache on success; fall back to stale on empty (rate-limited)
        if (total > 0) _cache = { data: payload, ts: Date.now() };
        if (total === 0 && _cache.data) return res.status(200).json({ ..._cache.data, stale: true });
        return res.status(200).json(payload);

    } catch (err) {
        if (_cache.data) return res.status(200).json({ ..._cache.data, stale: true });
        return res.status(200).json({ categories: [], total: 0, error: err.message, fetchedAt: new Date().toISOString() });
    }
};
