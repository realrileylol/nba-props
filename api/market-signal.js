// AI signal for a Kalshi mentions market
// Fetches live news + asks Claude whether YES is under/overpriced
// Cache s-maxage=300 so repeated opens of the same market don't burn API calls

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1/messages';
const NEWS_BASE      = 'https://news.google.com/rss/search';

function decodeEntities(s) {
    return (s || '')
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
        .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
        .replace(/<[^>]*>/g,'').trim();
}

async function fetchHeadlines(q) {
    try {
        const url = `${NEWS_BASE}?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
        const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheBooth/1.0)' },
            signal: AbortSignal.timeout(4000),
        });
        if (!r.ok) return [];
        const xml = await r.text();
        const items = [];
        const re = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = re.exec(xml)) && items.length < 6) {
            const b = m[1];
            const title  = decodeEntities((b.match(/<title>([\s\S]*?)<\/title>/)   || [])[1]);
            const link   = decodeEntities((b.match(/<link>([\s\S]*?)<\/link>/)     || [])[1]);
            const source = decodeEntities((b.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]);
            const pub    = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
            if (title) items.push({ title, link, source, pub });
        }
        return items;
    } catch (_) { return []; }
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=120');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { title = '', eventTitle = '', yesPct = '', yesOdds = '', noOdds = '' } = req.query;

    if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(200).json({ error: 'ANTHROPIC_API_KEY not set', signal: 'NEUTRAL' });
    }

    // Build news query from event + market subject
    const cleanEvent = eventTitle
        .replace(/what will the announcers say during/i, '')
        .replace(/professional (baseball|basketball|hockey|football) game/i, '')
        .trim();
    const newsQ = `${cleanEvent} ${title}`.slice(0, 100);
    const headlines = await fetchHeadlines(newsQ);

    const headlineBlock = headlines.length
        ? headlines.map((h, i) => `${i + 1}. "${h.title}" (${h.source})`).join('\n')
        : 'No recent headlines found.';

    const pct    = parseFloat(yesPct) || null;
    const oddsYes = yesOdds ? `${yesOdds}` : 'n/a';
    const oddsNo  = noOdds  ? `${noOdds}`  : 'n/a';

    const prompt = `You are an expert sports betting analyst specializing in Kalshi broadcast mentions markets.

MARKET: "${title}"
EVENT: "${cleanEvent}"
CURRENT ODDS: YES ${oddsYes} (${pct != null ? pct + '% implied' : 'unknown'}) / NO ${oddsNo}

RECENT NEWS & CONTEXT:
${headlineBlock}

TASK: Determine if this market is mispriced given the current narrative context. Broadcast announcers will mention a topic more if it's a dominant storyline today.

Respond ONLY with valid JSON in this exact format:
{
  "signal": "YES_LEAN" | "NO_LEAN" | "NEUTRAL",
  "confidence": <integer 50-95>,
  "verdict": "<one sentence: what the signal is and why>",
  "edge": "<one sentence: what specific evidence supports this edge>"
}`;

    try {
        const r = await fetch(ANTHROPIC_BASE, {
            method: 'POST',
            headers: {
                'x-api-key':         process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type':      'application/json',
            },
            body: JSON.stringify({
                model:      'claude-haiku-4-5-20251001',
                max_tokens: 200,
                messages:   [{ role: 'user', content: prompt }],
            }),
            signal: AbortSignal.timeout(8000),
        });

        if (!r.ok) {
            const err = await r.text();
            return res.status(200).json({ signal: 'NEUTRAL', error: `Claude ${r.status}: ${err.slice(0,120)}`, headlines });
        }

        const body = await r.json();
        const raw  = body?.content?.[0]?.text || '{}';
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch (_) {
            // Claude occasionally wraps JSON in markdown — strip it
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) try { parsed = JSON.parse(match[0]); } catch (_) {}
        }

        res.status(200).json({
            signal:     parsed.signal     || 'NEUTRAL',
            confidence: parsed.confidence || 60,
            verdict:    parsed.verdict    || '',
            edge:       parsed.edge       || '',
            headlines,
            model:      'claude-haiku-4-5-20251001',
        });
    } catch (err) {
        res.status(200).json({ signal: 'NEUTRAL', error: err.message, headlines });
    }
};
