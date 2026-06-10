// Kalshi Mentions — mirrors kalshi.com/category/mentions
//
// Key facts learned from production debug:
//   - /series/?category=Mentions returns ~367 series (authoritative mentions list)
//   - Mentions markets are status "unopened" until shortly before each broadcast,
//     so a status=open market filter wrongly returns nothing during the day.
//   - Vercel Hobby kills functions at 10s — total budget here is ~7.5s worst case.
//
// Flow:
//   Round 1 (parallel, ≤4s): series list + paginated open-events scan
//   Match:  scanned events whose series_ticker is a mentions series (+ title fallback)
//   Round 2 (parallel, ≤3.5s): one batch of per-event market fetches, NO status filter

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
    const d = await getJSON(`${KALSHI_BASE}/series/?category=Mentions`, 3800);
    return d?.series || [];
}

const SAY_RE   = /\bsay\b|\bsays\b|\bsaid\b|\bsaying\b|\bmention/i;
const TRUMP_RE = /\btrump\b/i;
const SPORTS_RE = /baseball|basketball|hockey|football|soccer|\bnba\b|\bmlb\b|\bnhl\b|\bnfl\b|\bmls\b|announcer|tennis|golf|\bgame\b/i;

// Paginated open-events scan — returns ALL events seen (matching happens later
// against the series set, which we don't have until Round 1 completes)
async function scanOpenEvents() {
    const all = [];
    let cursor = null;
    const deadline = Date.now() + 4000;
    for (let page = 0; page < 4 && Date.now() < deadline - 300; page++) {
        const qs = new URLSearchParams({ status: 'open', limit: '200' });
        if (cursor) qs.set('cursor', cursor);
        const d = await getJSON(`${KALSHI_BASE}/events?${qs}`, Math.max(800, deadline - Date.now()));
        if (!d) break;
        all.push(...(d.events || []));
        cursor = d.cursor;
        if (!cursor || !(d.events || []).length) break;
    }
    return all;
}

// No status filter — include unopened markets (they open near game time)
async function fetchEventMarkets(eventTicker) {
    const qs = new URLSearchParams({ limit: '60', event_ticker: eventTicker });
    const d = await getJSON(`${KALSHI_BASE}/markets?${qs}`, 3500);
    return d?.markets || [];
}

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
        status:       m.status || null,          // 'open' | 'unopened' | ...
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
    const usable = (rawMarkets || []).filter(m => m.status !== 'settled' && m.status !== 'closed');
    const markets = usable.map(shapeMarket).sort((a, b) => {
        const ao = a.status === 'open' ? 0 : 1;
        const bo = b.status === 'open' ? 0 : 1;
        return ao - bo || (b.volume || 0) - (a.volume || 0);
    });
    if (!markets.length) return null;
    return {
        eventTicker: event.event_ticker,
        title:       event.title,
        closeTime:   event.close_time || markets[0].closeTime || null,
        total:       markets.length,
        markets:     markets.slice(0, 25),
    };
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
        // Round 1
        const [mentionsSeries, openEvents] = await Promise.all([
            fetchMentionsSeries(),
            scanOpenEvents(),
        ]);

        const mentionTickers = new Set(mentionsSeries.map(s => s.ticker).filter(Boolean));

        // An event is a mentions event if its series is in the Mentions category,
        // or (fallback) its title reads like one
        const mentionEvents = openEvents.filter(e => {
            if (e.series_ticker && mentionTickers.has(e.series_ticker)) return true;
            const t = e.title || '';
            return SAY_RE.test(t) || TRUMP_RE.test(t);
        });

        // Fetch all matches — cap at 25 parallel requests to stay inside Vercel 10s budget
        const toFetch = mentionEvents.slice(0, 25);
        const marketLists = await Promise.all(toFetch.map(e => fetchEventMarkets(e.event_ticker)));

        // Bucket: Trump / Sports / All Others — NO content filtering, show everything
        const trumpEvents  = [];
        const sportsEvents = [];
        const otherEvents  = [];
        toFetch.forEach((event, i) => {
            const shaped = shapeEvent(event, marketLists[i]);
            if (!shaped) return;
            const t = event.title || '';
            if (TRUMP_RE.test(t))   trumpEvents.push(shaped);
            else if (SPORTS_RE.test(t)) sportsEvents.push(shaped);
            else                    otherEvents.push(shaped);
        });

        // Show ALL mentions — Sports first, Trump second, everything else third
        const categories = [];
        if (sportsEvents.length) categories.push({ id: 'sports', label: 'Sports',   events: sportsEvents });
        if (trumpEvents.length)  categories.push({ id: 'trump',  label: 'Political', events: trumpEvents });
        if (otherEvents.length)  categories.push({ id: 'other',  label: 'All Other', events: otherEvents });

        const total = categories.reduce((s, c) => s + c.events.reduce((es, ev) => es + ev.markets.length, 0), 0);

        res.status(200).json({
            categories, total,
            debug: {
                mentionsSeries:   mentionsSeries.length,
                openEventsScanned: openEvents.length,
                mentionEvents:    mentionEvents.length,
                fetched:          toFetch.length,
                withMarkets:      categories.reduce((s, c) => s + c.events.length, 0),
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
