// Vercel serverless — ESPN soccer data for any league/competition
// ?league=world-cup | premier-league | la-liga | bundesliga | serie-a | ligue-1 | champions-league
// Returns: live scores, group standings (WC only), upcoming fixtures

const SLUGS = {
    'world-cup':        'FIFA.world',
    'premier-league':   'eng.1',
    'la-liga':          'esp.1',
    'bundesliga':       'ger.1',
    'serie-a':          'ita.1',
    'ligue-1':          'fra.1',
    'champions-league': 'UEFA.champions',
};

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

function parseTeam(c) {
    return {
        id:     c.team?.id || null,
        name:   c.team?.shortDisplayName || c.team?.displayName || '—',
        abbrev: c.team?.abbreviation || '—',
        logo:   c.team?.logo || null,
        home:   c.homeAway === 'home',
        score:  c.score  || '0',
        winner: c.winner || false,
        record: c.records?.[0]?.summary || null,
    };
}

function parseEvents(events) {
    return (events || []).map(e => {
        const comp  = e.competitions?.[0] || {};
        const teams = (comp.competitors || []).map(parseTeam);
        const state = comp.status?.type?.state || 'pre';
        return {
            id:     e.id,
            date:   e.date,
            state,
            status: comp.status?.type?.shortDetail || 'Scheduled',
            home:   teams.find(t =>  t.home) || null,
            away:   teams.find(t => !t.home) || null,
            venue:  comp.venue?.fullName || '',
            city:   comp.venue?.address?.city || '',
            clock:  comp.status?.displayClock || null,
            period: comp.status?.period || null,
            note:   comp.notes?.[0]?.headline || null, // group name, round info etc.
        };
    });
}

function parseGroups(standingsData) {
    if (!standingsData) return null;
    // ESPN wraps group standings in different shapes — normalise
    const raw = standingsData.children
        || standingsData.standings?.entries ? [standingsData.standings] : []
        || [];
    return raw.map(g => {
        const entries = g.standings?.entries || g.entries || [];
        return {
            name: g.name || g.abbreviation || 'Group',
            teams: entries.map(e => {
                const stats = {};
                (e.stats || []).forEach(s => { stats[s.abbreviation] = s.value; });
                return {
                    name: e.team?.shortDisplayName || e.team?.displayName || '—',
                    abbrev: e.team?.abbreviation || '—',
                    gp:  +(stats.GP  || stats.gamesPlayed || 0),
                    w:   +(stats.W   || stats.wins        || 0),
                    d:   +(stats.D   || stats.ties        || 0),
                    l:   +(stats.L   || stats.losses      || 0),
                    gf:  +(stats.GF  || stats.pointsFor   || 0),
                    ga:  +(stats.GA  || stats.pointsAgainst || 0),
                    pts: +(stats.PTS || stats.points      || 0),
                };
            }).sort((a, b) => b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga)),
        };
    });
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { league = 'world-cup' } = req.query;
    const slug = SLUGS[league] || 'FIFA.world';
    const isWC = league === 'world-cup';

    try {
        const fetches = [fetch(`${BASE}/${slug}/scoreboard`)];
        if (isWC) fetches.push(fetch(`${BASE}/${slug}/standings`));

        const responses = await Promise.all(fetches);
        const [scoreboard, standings] = await Promise.all(responses.map(r => r.json()));

        res.status(200).json({
            events: parseEvents(scoreboard.events),
            groups: isWC ? parseGroups(standings) : null,
            season: scoreboard.season || null,
            fetchedAt: new Date().toISOString(),
        });
    } catch (err) {
        res.status(200).json({
            events: [], groups: null,
            error: err.message,
            fetchedAt: new Date().toISOString(),
        });
    }
};
