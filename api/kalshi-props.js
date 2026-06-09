// Vercel serverless — Kalshi broadcaster mention markets
// Uses search API for targeted results (reliable) instead of browsing all markets
// Returns markets grouped by broadcaster: Breen / Jefferson / Legler / General NBA

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

function getHeaders() {
    const key = process.env.KALSHI_API_KEY || '';
    return {
        'Authorization': key.startsWith('Bearer ') ? key : `Bearer ${key}`,
        'Accept': 'application/json',
    };
}

// Each search fails silently so one timeout doesn't kill the whole request
async function searchMarkets(query) {
    try {
        const url = `${KALSHI_BASE}/markets?status=open&limit=100&search=${encodeURIComponent(query)}`;
        const res = await fetch(url, { headers: getHeaders(), signal: AbortSignal.timeout(4500) });
        if (!res.ok) return [];
        const data = await res.json();
        return data.markets || data.market_candidates || [];
    } catch (_) {
        return [];
    }
}

function toAmericanOdds(priceCents) {
    if (priceCents == null || priceCents <= 0 || priceCents >= 100) return null;
    const p = priceCents / 100;
    return p >= 0.5
        ? Math.round(-(p / (1 - p)) * 100)
        : Math.round(((1 - p) / p) * 100);
}

function shape(m) {
    const yesAsk = m.yes_ask ?? null;
    const noAsk  = m.no_ask  ?? null;
    return {
        ticker:       m.ticker,
        title:        m.title || m.subtitle || m.ticker,
        subtitle:     m.subtitle || null,
        yesOdds:      toAmericanOdds(yesAsk),
        noOdds:       toAmericanOdds(noAsk),
        yesPct:       yesAsk,
        noPct:        noAsk,
        volume:       m.volume        || 0,
        openInterest: m.open_interest || 0,
        closeTime:    m.close_time    || null,
    };
}

function detectGroup(m) {
    const text = `${m.title || ''} ${m.subtitle || ''}`.toLowerCase();
    if (/breen|bang!?/.test(text))  return 'breen';
    if (/jefferson/.test(text))     return 'jefferson';
    if (/legler/.test(text))        return 'legler';
    return 'general';
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=15');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!process.env.KALSHI_API_KEY) {
        return res.status(200).json({
            groups: [], total: 0,
            error: 'KALSHI_API_KEY not set — add it in Vercel → Project Settings → Environment Variables',
            fetchedAt: new Date().toISOString(),
        });
    }

    try {
        // 7 parallel searches — all fail silently so partial results still render
        const results = await Promise.all([
            searchMarkets('Breen'),
            searchMarkets('Jefferson'),
            searchMarkets('Legler'),
            searchMarkets('say NBA'),
            searchMarkets('mention NBA'),
            searchMarkets('NBA Finals word'),
            searchMarkets('NBA word'),
        ]);

        // Deduplicate by ticker
        const seen = new Set();
        const all  = results.flat().filter(m => {
            if (seen.has(m.ticker)) return false;
            seen.add(m.ticker);
            return true;
        });

        // Drop obvious multi-leg parlays
        const simple = all.filter(m => {
            const t = m.title || '';
            if ((t.match(/\b(yes|no)\s+\S/gi) || []).length > 1) return false;
            if ((t.match(/,/g) || []).length >= 6) return false;
            return true;
        });

        // Group by broadcaster
        const GROUPS = {
            breen:     { id: 'breen',     label: 'Mike Breen',           icon: '🎙', markets: [] },
            jefferson: { id: 'jefferson', label: 'Richard Jefferson',    icon: '🏀', markets: [] },
            legler:    { id: 'legler',    label: 'Tim Legler',           icon: '📊', markets: [] },
            general:   { id: 'general',   label: 'NBA Finals · General', icon: '🏆', markets: [] },
        };

        simple.forEach(m => {
            GROUPS[detectGroup(m)].markets.push(shape(m));
        });

        // Sort by volume within each group, drop empty groups
        const groups = Object.values(GROUPS)
            .map(g => ({ ...g, markets: g.markets.sort((a, b) => (b.volume || 0) - (a.volume || 0)) }))
            .filter(g => g.markets.length > 0);

        res.status(200).json({
            groups,
            total: simple.length,
            fetchedAt: new Date().toISOString(),
        });
    } catch (err) {
        res.status(200).json({
            groups: [], total: 0,
            error: err.message,
            fetchedAt: new Date().toISOString(),
        });
    }
};
