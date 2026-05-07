// api/fetch-jobs.js — Vercel serverless function
// Tuned for Sport for Good / Community Impact / Social Impact through Sports roles

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prefs } = req.body;
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const serpKey = process.env.SERPAPI_KEY;

  const allJobs = [];

  // ── 1. Google Jobs via Serpapi ─────────────────────────────────────────
  // Google Jobs actually indexes Teamwork Online, idealist.org, and niche sport
  // nonprofit boards — so one Serpapi call covers many sources at once
  if (serpKey) {
    const titles = prefs.titles
      ? prefs.titles.split(',').map(t => t.trim())
      : ['community relations sports', 'sport for good program manager'];

    const queriesToRun = [
      ...titles.map(t => `${t} sports nonprofit`),
      'sport for development community impact jobs',
      'sports foundation program coordinator',
      'community outreach sports organization',
    ].slice(0, 4); // Max 4 searches to stay in 100/month free tier

    for (const query of queriesToRun) {
      try {
        const encoded = encodeURIComponent(query);
        const url = `https://serpapi.com/search.json?engine=google_jobs&q=${encoded}&api_key=${serpKey}&hl=en&num=10`;
        const r = await fetch(url);
        const d = await r.json();

        for (const job of (d.jobs_results || []).slice(0, 8)) {
          const isDupe = allJobs.some(j =>
            j.title === job.title && j.company === job.company_name
          );
          if (!isDupe) allJobs.push(normalizeGoogleJob(job));
        }
      } catch (e) {
        console.error('Serpapi error:', e.message);
      }
    }
  }

  // ── 2. Sport-for-Good orgs using Workday (free, no key needed) ────────
  const WORKDAY_ORGS = [
    { name: 'Right To Play', slug: 'righttoplay' },
    { name: 'Special Olympics', slug: 'specialolympics' },
    { name: 'US Soccer Federation', slug: 'ussoccer' },
    { name: 'NBA', slug: 'nba' },
    { name: 'NFL', slug: 'nfl' },
    { name: 'MLB', slug: 'mlb' },
    { name: 'MLS', slug: 'mlssoccer' },
    { name: 'WNBA', slug: 'wnba' },
    { name: 'Team USA / USOPC', slug: 'teamusa' },
  ];

  const keywords = prefs.titles
    ? prefs.titles.split(',').map(t => t.trim().toLowerCase())
    : ['community', 'outreach', 'program', 'impact', 'foundation', 'relations'];

  for (const org of WORKDAY_ORGS) {
    try {
      const workdayUrl = `https://${org.slug}.wd1.myworkdayjobs.com/wday/cxs/${org.slug}/External/jobs`;
      const r = await fetch(workdayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: 'community' })
      });
      if (!r.ok) continue;
      const d = await r.json();

      const matches = (d.jobPostings || [])
        .filter(j => keywords.some(k => j.title?.toLowerCase().includes(k)))
        .slice(0, 3);

      for (const job of matches) {
        const isDupe = allJobs.some(j => j.title === job.title && j.company === org.name);
        if (!isDupe) {
          allJobs.push({
            id: `wd_${org.slug}_${Math.random().toString(36).slice(2)}`,
            title: job.title,
            company: org.name,
            location: job.locationsText || 'See listing',
            salary: null,
            source: 'Workday',
            sourceEmoji: '💼',
            logo: getSportOrgEmoji(org.name),
            posted: job.postedOn || 'Recently',
            url: `https://${org.slug}.wd1.myworkdayjobs.com/External`,
            description: `${job.title} at ${org.name}`,
            tags: ['Full-time'],
            status: 'pending',
            match: 0, summary: '', why: '', skills: [],
          });
        }
      }
    } catch (_) { /* org may not use Workday */ }
  }

  // ── 3. Greenhouse — impact orgs that use it ───────────────────────────
  const GREENHOUSE_ORGS = [
    'streetleague', 'pencilsofpromise', 'dosomething',
    'bigbrotherbigsisters', 'girlsinc', 'peaceplayers',
  ];

  for (const org of GREENHOUSE_ORGS) {
    try {
      const r = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${org}/jobs?content=true`,
        { headers: { 'User-Agent': 'JobPilot/1.0' } }
      );
      if (!r.ok) continue;
      const d = await r.json();

      const matches = (d.jobs || [])
        .filter(j => keywords.some(k => j.title?.toLowerCase().includes(k)))
        .slice(0, 3);

      for (const job of matches) {
        allJobs.push({
          id: `gh_${job.id}`,
          title: job.title,
          company: org.charAt(0).toUpperCase() + org.slice(1),
          location: job.location?.name || 'See listing',
          salary: null,
          source: 'Greenhouse',
          sourceEmoji: '🌱',
          logo: '🤝',
          posted: 'Recently',
          url: job.absolute_url || '#',
          description: stripHtml(job.content || '').slice(0, 2000),
          tags: ['Nonprofit', 'Full-time'],
          status: 'pending',
          match: 0, summary: '', why: '', skills: [],
        });
      }
    } catch (_) { /* skip */ }
  }

  if (allJobs.length === 0) {
    return res.status(200).json({ jobs: [], message: 'No jobs found. Check that SERPAPI_KEY is set in Vercel.' });
  }

  // ── 4. Score with Claude Haiku ─────────────────────────────────────────
  if (claudeKey) await scoreJobs(allJobs, prefs, claudeKey);

  // ── 5. Filter + sort ──────────────────────────────────────────────────
  const avoidList = (prefs.avoid || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

  const final = allJobs
    .filter(j => !claudeKey || j.match >= 45)
    .filter(j => !avoidList.some(a => j.company.toLowerCase().includes(a)))
    .sort((a, b) => b.match - a.match)
    .slice(0, 30);

  return res.status(200).json({ jobs: final });
}

async function scoreJobs(jobs, prefs, claudeKey) {
  for (let i = 0; i < jobs.length; i += 5) {
    const batch = jobs.slice(i, i + 5);
    const prompt = `You are helping someone find jobs in "Sport for Good" — using sports for community development, social impact, and youth programs.

CANDIDATE:
- Target roles: ${prefs.titles || 'community relations, program manager, outreach coordinator'}
- Skills: ${prefs.skills || 'not specified'}
- Location: ${prefs.locations || 'any'}
- Experience: ${prefs.exp || '?'} years

JOBS:
${batch.map((j, idx) => `[${idx}] "${j.title}" at ${j.company} (${j.location})\n${j.description?.slice(0, 250) || ''}`).join('\n\n')}

Score 0-100 for fit with a sport-for-good / community impact career.
Return ONLY this JSON, no other text:
[{"idx":0,"match":78,"summary":"<20 word role description>","why":"<20 word reason it fits>","skills":["s1","s2"]}]`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const d = await r.json();
      const scores = JSON.parse((d.content?.[0]?.text || '[]').replace(/```json|```/g, '').trim());
      for (const s of scores) {
        if (batch[s.idx]) Object.assign(batch[s.idx], { match: s.match, summary: s.summary, why: s.why, skills: s.skills || [] });
      }
    } catch (e) {
      batch.forEach(j => { j.match = 65; j.summary = j.title; j.why = 'Review manually'; });
    }
  }
}

function normalizeGoogleJob(raw) {
  return {
    id: `gj_${raw.job_id || Math.random().toString(36).slice(2)}`,
    title: raw.title,
    company: raw.company_name,
    location: raw.location || 'Not specified',
    salary: raw.detected_extensions?.salary_mentioned || null,
    source: 'Google Jobs',
    sourceEmoji: '🔵',
    logo: getSportOrgEmoji(raw.company_name),
    posted: raw.detected_extensions?.posted_at || 'Recently',
    url: raw.share_link || '#',
    description: raw.description || '',
    tags: buildTags(raw),
    status: 'pending',
    match: 0, summary: '', why: '', skills: [],
  };
}

function buildTags(job) {
  const tags = [];
  const desc = ((job.description || '') + (job.title || '')).toLowerCase();
  if (job.detected_extensions?.work_from_home || desc.includes('remote')) tags.push('Remote');
  else if (desc.includes('hybrid')) tags.push('Hybrid');
  tags.push(job.detected_extensions?.schedule_type || 'Full-time');
  if (desc.includes('nonprofit') || desc.includes('non-profit')) tags.push('Nonprofit');
  return [...new Set(tags)];
}

function getSportOrgEmoji(name = '') {
  const n = name.toLowerCase();
  if (n.includes('soccer') || n.includes('mls') || n.includes('fifa')) return '⚽';
  if (n.includes('basketball') || n.includes('nba') || n.includes('wnba')) return '🏀';
  if (n.includes('baseball') || n.includes('mlb')) return '⚾';
  if (n.includes('hockey') || n.includes('nhl')) return '🏒';
  if (n.includes('olympic') || n.includes('usopc') || n.includes('team usa')) return '🏅';
  if (n.includes('right to play')) return '🎯';
  if (n.includes('special olympics')) return '🌟';
  if (n.includes('ymca') || n.includes('youth')) return '🧒';
  if (n.includes('nfl') || n.includes('football')) return '🏈';
  if (n.includes('foundation') || n.includes('nonprofit') || n.includes('outreach')) return '🤝';
  return '🏟️';
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
