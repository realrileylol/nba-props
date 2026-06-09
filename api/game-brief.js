// Vercel serverless function — fetches tonight's NBA game + headlines from ESPN's
// public (unofficial but stable) API. No auth required, no scraping needed.
// Cached 5 min at the edge so repeated page loads don't hammer ESPN.

const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const ESPN_NEWS       = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=8';

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        const [sbRes, newsRes] = await Promise.all([
            fetch(ESPN_SCOREBOARD),
            fetch(ESPN_NEWS),
        ]);

        if (!sbRes.ok || !newsRes.ok) {
            throw new Error(`ESPN responded ${sbRes.status} / ${newsRes.status}`);
        }

        const [sb, news] = await Promise.all([sbRes.json(), newsRes.json()]);

        // ── Game ────────────────────────────────────────────────────────────────
        const events = sb.events || [];

        // Prefer a postseason / Finals game; fall back to first event today
        const event = events.find(e =>
            e.season?.type === 3 ||                           // postseason type
            e.competitions?.[0]?.series?.type === 'playoff' ||
            /finals/i.test(e.name || '')
        ) || events[0] || null;

        let game = null;
        if (event) {
            const comp   = event.competitions[0];
            const venue  = comp?.venue || {};
            const name   = venue.fullName || '';
            const atMSG  = /madison square garden|msg/i.test(name);

            const teams = (comp.competitors || []).map(c => ({
                name:   c.team?.shortDisplayName || c.team?.displayName,
                abbrev: c.team?.abbreviation,
                home:   c.homeAway === 'home',
                score:  c.score   || null,
                record: c.records?.[0]?.summary || null,
                winner: c.winner  || false,
            }));

            const state = comp.status?.type?.state || 'pre'; // pre | in | post

            game = {
                name:          event.shortName || event.name,
                date:          event.date,
                state,                                        // pre / in / post
                status:        comp.status?.type?.shortDetail || 'Scheduled',
                venue:         name,
                city:          venue.address?.city || '',
                atMSG,
                home:          teams.find(t =>  t.home) || null,
                away:          teams.find(t => !t.home) || null,
                seriesSummary: comp.series?.summary || null,
            };
        }

        // ── Headlines ───────────────────────────────────────────────────────────
        // Flag injury-related articles so the frontend can highlight them
        const injuryKeywords = /injur|ankle|knee|questionable|doubtful|out|ruled out/i;

        const headlines = (news.articles || []).slice(0, 6).map(a => ({
            headline:    a.headline,
            description: a.description || null,
            isInjury:    injuryKeywords.test(a.headline + ' ' + (a.description || '')),
            published:   a.published || null,
        }));

        res.status(200).json({ game, headlines, fetchedAt: new Date().toISOString() });

    } catch (err) {
        // Always return 200 so the frontend can show a degraded state rather than crash
        res.status(200).json({
            game:      null,
            headlines: [],
            error:     err.message,
            fetchedAt: new Date().toISOString(),
        });
    }
};
