// Diagnostic endpoint — exposes raw Kalshi API responses
// Visit /api/kalshi-debug in browser to see exactly what Kalshi returns
// DELETE this file before shipping to production

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const apiKey = process.env.KALSHI_API_KEY || '';
    const authHeader = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;

    const results = {};

    // 1. Test: fetch all open markets (no search filter)
    try {
        const r = await fetch(`${KALSHI_BASE}/markets?status=open&limit=5`, {
            headers: { Authorization: authHeader, Accept: 'application/json' },
            signal: AbortSignal.timeout(6000),
        });
        const body = await r.text();
        results.allMarkets = {
            status: r.status,
            ok: r.ok,
            bodyPreview: body.slice(0, 800),
        };
    } catch (e) {
        results.allMarkets = { error: e.message };
    }

    // 2. Test: search for "Breen"
    try {
        const r = await fetch(`${KALSHI_BASE}/markets?status=open&limit=10&search=Breen`, {
            headers: { Authorization: authHeader, Accept: 'application/json' },
            signal: AbortSignal.timeout(6000),
        });
        const body = await r.text();
        results.searchBreen = {
            status: r.status,
            ok: r.ok,
            bodyPreview: body.slice(0, 800),
        };
    } catch (e) {
        results.searchBreen = { error: e.message };
    }

    // 3. Test: search for "NBA"
    try {
        const r = await fetch(`${KALSHI_BASE}/markets?status=open&limit=10&search=NBA`, {
            headers: { Authorization: authHeader, Accept: 'application/json' },
            signal: AbortSignal.timeout(6000),
        });
        const body = await r.text();
        results.searchNBA = {
            status: r.status,
            ok: r.ok,
            bodyPreview: body.slice(0, 800),
        };
    } catch (e) {
        results.searchNBA = { error: e.message };
    }

    // 4. Test: fetch events endpoint
    try {
        const r = await fetch(`${KALSHI_BASE}/events?status=open&limit=5`, {
            headers: { Authorization: authHeader, Accept: 'application/json' },
            signal: AbortSignal.timeout(6000),
        });
        const body = await r.text();
        results.events = {
            status: r.status,
            ok: r.ok,
            bodyPreview: body.slice(0, 800),
        };
    } catch (e) {
        results.events = { error: e.message };
    }

    res.status(200).json({
        apiKeySet: !!apiKey,
        apiKeyPrefix: apiKey ? apiKey.slice(0, 12) + '...' : '(not set)',
        results,
        checkedAt: new Date().toISOString(),
    });
};
