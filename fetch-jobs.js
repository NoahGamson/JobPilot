// api/fetch-jobs.js  — Vercel serverless function
// Deployed automatically when you push to GitHub

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prefs } = req.body;

  if (!prefs?.titles) {
    return res.status(400).json({ error: 'No job titles configured. Please fill out your profile first.' });
  }

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const serpKey = process.env.SERPAPI_KEY;
  const allJobs = [];

  // ── 1. Google Jobs via Serpapi ─────────────────────────────────────────
  if (serpKey) {
    const titles = prefs.titles.split(',').map(t => t.trim()).slice(0, 2);
    const location = (prefs.locations || 'Remote').split(',')[0].trim();

    for (const title of titles) {
      try {
        const query = encodeURIComponent(`${title} ${location}`);
        const url = `https://serpapi.com/search.json?engine=google_jobs&q=${query}&api_key=${serpKey}&hl=en`;
        const r = await fetch(url);
        const d = await r.json();

        for (const job of (d.jobs_results || []).slice(0, 8)) {
          allJobs.push(normalizeJob(job, 'Google Jobs', '🔵'));
        }
      } catch (e) {
        console.error('Serpapi error:', e.message);
      }
    }
  }

  // ── 2. Greenhouse public boards (free, no key needed) ──────────────────
  const companies = (process.env.GREENHOUSE_COMPANIES || 'stripe,notion,figma,linear,vercel,anthropic,openai').split(',');
  const keywords = prefs.titles.split(',').map(t => t.trim().toLowerCase().split(' ')[0]);

  for (const company of companies.slice(0, 7)) {
    try {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${company.trim()}/jobs?content=true`, {
        headers: { 'User-Agent': 'JobPilot/1.0' }
      });
      if (!r.ok) continue;
      const d = await r.json();

      const matches = (d.jobs || []).filter(j =>
        keywords.some(k => j.title.toLowerCase().includes(k))
      ).slice(0, 3);

      for (const job of matches) {
        allJobs.push({
          id: `gh_${job.id}`,
          title: job.title,
          company: company.charAt(0).toUpperCase() + company.slice(1),
          location: job.location?.name || 'Remote',
          salary: null,
          source: 'Greenhouse',
          sourceEmoji: '🌱',
          logo: getLogoEmoji(company),
          posted: 'Recently',
          url: job.absolute_url || '#',
          description: stripHtml(job.content || '').slice(0, 2000),
          tags: ['Full-time'],
          status: 'pending',
          match: 0,
          summary: '',
          why: '',
          skills: [],
        });
      }
    } catch (_) { /* skip */ }
  }

  if (allJobs.length === 0) {
    return res.status(200).json({ jobs: [] });
  }

  // ── 3. Score & summarize with Claude ──────────────────────────────────
  if (claudeKey) {
    await scoreAndSummarize(allJobs, prefs, claudeKey);
  }

  // ── 4. Filter and sort ────────────────────────────────────────────────
  const avoidList = (prefs.avoid || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const scored = allJobs
    .filter(j => j.match >= 50 || !claudeKey)
    .filter(j => !avoidList.some(a => j.company.toLowerCase().includes(a)))
    .sort((a, b) => b.match - a.match);

  return res.status(200).json({ jobs: scored });
}

// ── Score all jobs with Claude Haiku (cheap + fast) ───────────────────────
async function scoreAndSummarize(jobs, prefs, claudeKey) {
  const batchSize = 5;

  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);

    const prompt = `Score these job listings for a candidate and return ONLY valid JSON.

CANDIDATE:
- Target roles: ${prefs.titles}
- Skills: ${prefs.skills || 'not specified'}
- Location preference: ${prefs.locations || 'any'}
- Min salary: ${prefs.salary ? '$' + prefs.salary : 'not specified'}
- Experience: ${prefs.exp || '?'} years

JOBS:
${batch.map((j, idx) => `[${idx}] ${j.title} @ ${j.company} (${j.location})\n${j.description.slice(0, 300)}`).join('\n\n')}

Return ONLY this JSON array with no other text:
[{"idx":0,"match":82,"summary":"<20 word plain summary>","why":"<20 word reason this fits candidate>","skills":["skill1","skill2"]}]`;

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
      const raw = d.content?.[0]?.text || '[]';
      const scores = JSON.parse(raw.replace(/```json|```/g, '').trim());

      for (const s of scores) {
        if (batch[s.idx]) {
          Object.assign(batch[s.idx], {
            match: s.match,
            summary: s.summary,
            why: s.why,
            skills: s.skills || []
          });
        }
      }
    } catch (e) {
      console.error('Scoring error:', e.message);
      batch.forEach(j => { j.match = 70; j.summary = j.title; j.why = 'Review manually'; });
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function normalizeJob(raw, source, emoji) {
  return {
    id: `gj_${raw.job_id || Math.random().toString(36).slice(2)}`,
    title: raw.title,
    company: raw.company_name,
    location: raw.location || 'Not specified',
    salary: raw.detected_extensions?.salary_mentioned || null,
    source,
    sourceEmoji: emoji,
    logo: getLogoEmoji(raw.company_name),
    posted: raw.detected_extensions?.posted_at || 'Recently',
    url: raw.share_link || '#',
    description: raw.description || '',
    tags: buildTags(raw),
    status: 'pending',
    match: 0,
    summary: '',
    why: '',
    skills: [],
  };
}

function buildTags(job) {
  const tags = [];
  const desc = (job.description || '').toLowerCase();
  if (job.detected_extensions?.work_from_home || desc.includes('remote')) tags.push('Remote');
  else if (desc.includes('hybrid')) tags.push('Hybrid');
  tags.push(job.detected_extensions?.schedule_type || 'Full-time');
  return [...new Set(tags)];
}

function getLogoEmoji(name = '') {
  const map = {
    stripe:'💳',notion:'📝',figma:'🎨',google:'🔵',amazon:'📦',apple:'🍎',
    meta:'👥',netflix:'🎬',spotify:'🎵',airbnb:'🏠',uber:'🚗',microsoft:'🪟',
    salesforce:'☁️',shopify:'🛍',slack:'💬',zoom:'📹',github:'🐙',gitlab:'🦊',
    vercel:'▲',linear:'📐',anthropic:'🤖',openai:'✨',datadog:'🐶',twilio:'📞',
  };
  return map[name.toLowerCase().split(' ')[0]] || '🏢';
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
