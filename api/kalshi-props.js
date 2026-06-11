// Kalshi Mentions — new architecture (events endpoint bypassed entirely)
//
// Phase 1: GET /series/?category=Mentions  → 367 series (confirmed working)
// Phase 2: GET /markets?series_ticker=X   → live markets per series
// Two buckets returned: sports / political
// Cache: 30s warm-instance; stale fallback on error/empty

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
    const d = await getJSON(`${KALSHI_BASE}/series/?category=Mentions`, 5000);
    return d?.series || [];
}

async function fetchSeriesMarkets(seriesTicker) {
    const qs = new URLSearchParams({ series_ticker: seriesTicker, status: 'open', limit: '20' });
    const d = await getJSON(`${KALSHI_BASE}/markets?${qs}`, 3000);
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

// 30s warm-instance cache
let _cache = { data: null, ts: 0 };
const CACHE_MS = 30_000;

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=15');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!process.env.KALSHI_API_KEY) {
        return res.status(200).json({ sports: [], political: [], total: 0,
            error: 'KALSHI_API_KEY not set', fetchedAt: new Date().toISOString() });
    }

    if (_cache.data && Date.now() - _cache.ts < CACHE_MS) {
        return res.status(200).json({ ..._cache.data, cached: true });
    }

    try {
        // Phase 1: all mentions series
        const allSeries = await fetchMentionsSeries();
        if (!allSeries.length) throw new Error('No mentions series returned from Kalshi');

        // Categorize into sports / political (skip other)
        const sportsSeries = [], politicalSeries = [];
        for (const s of allSeries) {
            const tag = tagForSeries(s.ticker, s.title);
            const cat = categoryForTag(tag);
            if (cat === 'sports')    sportsSeries.push({ ...s, tag });
            else if (cat === 'political') politicalSeries.push({ ...s, tag });
        }

        // Pick top N — Kalshi returns series sorted by activity
        const toFetch = [
            ...sportsSeries.slice(0, 12),
            ...politicalSeries.slice(0, 6),
        ];

        // Phase 2: fetch markets per series in parallel
        const marketResults = await Promise.all(
            toFetch.map(s => fetchSeriesMarkets(s.ticker))
        );

        const now = Date.now();
        const sportsBucket = [], politicalBucket = [];

        toFetch.forEach((series, i) => {
            const rawMarkets = marketResults[i] || [];
            const usable = rawMarkets.filter(m =>
                m.status !== 'settled' && m.status !== 'closed' && m.status !== 'finalized' &&
                (!m.close_time || new Date(m.close_time).getTime() > now));
            const markets = usable.map(shapeMarket)
                .sort((a, b) => (b.volume || 0) - (a.volume || 0));
            if (!markets.length) return;

            const earliestClose = markets.reduce((min, m) => {
                if (!m.closeTime) return min;
                const t = new Date(m.closeTime).getTime();
                return (!min || t < min) ? t : min;
            }, null);

            const item = {
                seriesTicker: series.ticker,
                title:        series.title,
                tag:          series.tag,
                markets:      markets.slice(0, 20),
                total:        markets.length,
                earliestClose: earliestClose ? new Date(earliestClose).toISOString() : null,
            };

            if (categoryForTag(series.tag) === 'sports') sportsBucket.push(item);
            else politicalBucket.push(item);
        });

        const total = sportsBucket.reduce((n, s) => n + s.markets.length, 0)
                    + politicalBucket.reduce((n, s) => n + s.markets.length, 0);

        const payload = {
            sports: sportsBucket,
            political: politicalBucket,
            total,
            debug: {
                seriesCount:          allSeries.length,
                sportsSeries:         sportsSeries.length,
                politicalSeries:      politicalSeries.length,
                fetched:              toFetch.length,
                sportsWithMarkets:    sportsBucket.length,
                politicalWithMarkets: politicalBucket.length,
            },
            fetchedAt: new Date().toISOString(),
        };

        if (total > 0) _cache = { data: payload, ts: Date.now() };
        if (total === 0 && _cache.data) return res.status(200).json({ ..._cache.data, stale: true });
        return res.status(200).json(payload);

    } catch (err) {
        if (_cache.data) return res.status(200).json({ ..._cache.data, stale: true });
        return res.status(200).json({ sports: [], political: [], total: 0,
            error: err.message, fetchedAt: new Date().toISOString() });
    }
};
