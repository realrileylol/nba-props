// Vercel serverless — head-to-head match history between two teams
// ?teamId=123&opponentId=456&league=world-cup
// Returns W-L-D record + match list from last 3 seasons

const SLUGS = {
    'world-cup':        'FIFA.world',
    'premier-league':   'eng.1',
    'la-liga':          'esp.1',
    'bundesliga':       'ger.1',
    'serie-a':          'ita.1',
    'ligue-1':          'fra.1',
    'champions-league': 'UEFA.champions',
};

// Extra competition slugs tried for international (WC) teams
const INTL_EXTRA = ['UEFA.nations', 'CONMEBOL.qualifier', 'CONCACAF.wcq', 'FIFA.friendly'];

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

async function fetchSchedule(slug, teamId, season) {
    try {
        const r = await fetch(`${BASE}/${slug}/teams/${teamId}/schedule?season=${season}`);
        if (!r.ok) return [];
        const data = await r.json();
        return data.events || [];
    } catch { return []; }
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { teamId, opponentId, league = 'world-cup' } = req.query;

    if (!teamId || !opponentId) {
        return res.status(400).json({
            error: 'teamId and opponentId required',
            matches: [], record: { w: 0, d: 0, l: 0 },
        });
    }

    const slug   = SLUGS[league] || 'FIFA.world';
    const isIntl = league === 'world-cup' || league === 'champions-league';
    const seasons = [2026, 2025, 2024, 2023];
    const slugsToUse = isIntl ? [slug, ...INTL_EXTRA] : [slug];

    try {
        const fetches = [];
        for (const s of slugsToUse) {
            for (const year of seasons) {
                fetches.push(fetchSchedule(s, teamId, year));
            }
        }

        const results = await Promise.all(fetches);
        const allEvents = results.flat();

        // Keep only games where the opponent appears
        const h2h = allEvents.filter(e => {
            const competitors = e.competitions?.[0]?.competitors || [];
            return competitors.some(c => String(c.team?.id) === String(opponentId));
        });

        // Deduplicate by event ID, sort newest first
        const seen = new Set();
        const unique = h2h
            .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; })
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        let w = 0, d = 0, l = 0;

        const matches = unique.map(e => {
            const comp   = e.competitions?.[0] || {};
            const comps  = comp.competitors || [];
            const t1     = comps.find(c => String(c.team?.id) === String(teamId));
            const t2     = comps.find(c => String(c.team?.id) === String(opponentId));
            const homeSide = comps.find(c => c.homeAway === 'home');
            const awaySide = comps.find(c => c.homeAway === 'away');

            const s1    = parseInt(t1?.score || '0');
            const s2    = parseInt(t2?.score || '0');
            const state = comp.status?.type?.state || 'pre';

            let result = null;
            if (state === 'post') {
                if (s1 > s2)      { result = 'W'; w++; }
                else if (s1 < s2) { result = 'L'; l++; }
                else               { result = 'D'; d++; }
            }

            return {
                date:  e.date,
                state,
                home: {
                    name:  homeSide?.team?.shortDisplayName || homeSide?.team?.displayName || '—',
                    score: homeSide?.score ?? null,
                },
                away: {
                    name:  awaySide?.team?.shortDisplayName || awaySide?.team?.displayName || '—',
                    score: awaySide?.score ?? null,
                },
                status:      comp.status?.type?.shortDetail || '',
                competition: e.season?.type?.text || comp.notes?.[0]?.headline || slug,
                result,
            };
        });

        res.status(200).json({
            matches,
            record: { w, d, l },
            fetchedAt: new Date().toISOString(),
        });
    } catch (err) {
        res.status(200).json({
            matches: [], record: { w: 0, d: 0, l: 0 },
            error: err.message,
            fetchedAt: new Date().toISOString(),
        });
    }
};
