// JobPilot Backend API
// Built for Vercel serverless functions (free tier)
// Each file in /api/ becomes a serverless endpoint

// ─────────────────────────────────────────────────────────────
// This is the main API router logic
// Files: api/fetch-jobs.js  and  api/generate.js
// ─────────────────────────────────────────────────────────────

// ── api/fetch-jobs.js ─────────────────────────────────────────────────────
// POST /api/fetch-jobs
// Body: { prefs: { titles, locations, skills, salary, avoid } }
// Returns: { jobs: [...] }

export const fetchJobsHandler = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prefs } = req.body;

  if (!prefs?.titles) {
    return res.status(400).json({ error: 'No job titles configured in profile' });
  }

  try {
    const allJobs = [];
    const titles = prefs.titles.split(',').map(t => t.trim()).slice(0, 3); // Max 3 titles
    const locations = prefs.locations || 'Remote';

    for (const title of titles) {
      // ── Serpapi Google Jobs (100 free searches/month) ──────────────────────
      const serpKey = process.env.SERPAPI_KEY;
      if (serpKey) {
        const query = encodeURIComponent(`${title} ${locations}`);
        const serpUrl = `https://serpapi.com/search.json?engine=google_jobs&q=${query}&api_key=${serpKey}&num=10`;
        const serpRes = await fetch(serpUrl);
        const serpData = await serpRes.json();

        if (serpData.jobs_results) {
          for (const job of serpData.jobs_results) {
            allJobs.push({
              id: `gj_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
              title: job.title,
              company: job.company_name,
              location: job.location || 'Remote',
              salary: job.detected_extensions?.salary_mentioned || null,
              source: 'Google Jobs',
              sourceEmoji: '🔵',
              logo: getLogoEmoji(job.company_name),
              posted: job.detected_extensions?.posted_at || 'Recently',
              url: job.share_link || '#',
              description: job.description || '',
              tags: buildTags(job),
              status: 'pending',
              match: 0, // Will be scored by Claude below
              summary: '',
              why: '',
              skills: [],
            });
          }
        }
      }

      // ── Greenhouse public API (completely free) ───────────────────────────
      // Searches known companies' Greenhouse boards
      const ghCompanies = (process.env.GREENHOUSE_COMPANIES || 'stripe,notion,figma,linear,vercel').split(',');
      for (const company of ghCompanies.slice(0, 5)) {
        try {
          const ghRes = await fetch(`https://boards-api.greenhouse.io/v1/boards/${company.trim()}/jobs?content=true`);
          if (!ghRes.ok) continue;
          const ghData = await ghRes.json();

          const matching = (ghData.jobs || []).filter(j =>
            titles.some(t => j.title.toLowerCase().includes(t.toLowerCase().split(' ')[0]))
          ).slice(0, 3);

          for (const job of matching) {
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
              description: stripHtml(job.content || ''),
              tags: ['Full-time'],
              status: 'pending',
              match: 0,
              summary: '',
              why: '',
              skills: [],
            });
          }
        } catch (_) { /* skip failed company */ }
      }
    }

    // ── Score & summarize with Claude ─────────────────────────────────────
    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) {
      return res.status(200).json({ jobs: allJobs.slice(0, 20) });
    }

    const scoredJobs = await scoreJobsWithClaude(allJobs.slice(0, 20), prefs, claudeKey);

    // Filter out low matches and companies to avoid
    const avoidList = (prefs.avoid || '').toLowerCase().split(',').map(s => s.trim());
    const filtered = scoredJobs
      .filter(j => j.match >= 50)
      .filter(j => !avoidList.some(a => a && j.company.toLowerCase().includes(a)))
      .sort((a, b) => b.match - a.match);

    return res.status(200).json({ jobs: filtered });

  } catch (err) {
    console.error('fetch-jobs error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── api/generate.js ───────────────────────────────────────────────────────
// POST /api/generate
// Body: { job, prefs }
// Returns: { resumeUrl, coverUrl }

export const generateHandler = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { job, prefs } = req.body;
  const claudeKey = process.env.ANTHROPIC_API_KEY;

  if (!claudeKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set' });
  if (!job) return res.status(400).json({ error: 'No job provided' });

  try {
    const resumeB64 = process.env.RESUME_B64 || req.body.resumeB64;

    // ── Step 1: Generate tailored resume content ──────────────────────────
    const resumeContent = await generateResume(job, prefs, resumeB64, claudeKey);

    // ── Step 2: Generate cover letter ─────────────────────────────────────
    const coverContent = await generateCoverLetter(job, prefs, resumeContent, claudeKey);

    // ── Step 3: Convert to PDF and store ──────────────────────────────────
    const { resumeUrl, coverUrl } = await savePDFs(resumeContent, coverContent, job, prefs);

    return res.status(200).json({ resumeUrl, coverUrl });

  } catch (err) {
    console.error('generate error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function scoreJobsWithClaude(jobs, prefs, claudeKey) {
  // Score in batches of 5 to save API calls
  const results = [];

  for (let i = 0; i < jobs.length; i += 5) {
    const batch = jobs.slice(i, i + 5);
    const prompt = `You are a career advisor scoring job listings for a candidate.

CANDIDATE PROFILE:
- Name: ${prefs.name || 'Candidate'}
- Target roles: ${prefs.titles || 'Not specified'}
- Skills: ${prefs.skills || 'Not specified'}
- Preferred locations: ${prefs.locations || 'Any'}
- Min salary: $${prefs.salary || 'Not specified'}
- Years experience: ${prefs.exp || 'Not specified'}

JOBS TO SCORE:
${batch.map((j, idx) => `
[Job ${idx}]
Title: ${j.title}
Company: ${j.company}
Location: ${j.location}
Description: ${j.description?.slice(0, 400) || 'No description'}
`).join('\n')}

For each job, respond ONLY with a JSON array (no markdown, no explanation):
[
  {
    "idx": 0,
    "match": 85,
    "summary": "One sentence describing the role in plain English (max 25 words)",
    "why": "One sentence explaining why it matches this candidate (max 30 words)",
    "skills": ["skill1", "skill2", "skill3"]
  }
]`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';

    try {
      const scores = JSON.parse(text.replace(/```json|```/g, '').trim());
      for (const score of scores) {
        const job = batch[score.idx];
        if (job) {
          job.match = score.match;
          job.summary = score.summary;
          job.why = score.why;
          job.skills = score.skills || [];
        }
      }
    } catch (_) { /* use unscored jobs */ }

    results.push(...batch);
  }

  return results;
}

async function generateResume(job, prefs, resumeB64, claudeKey) {
  const hasResume = !!resumeB64;

  const messages = hasResume
    ? [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: resumeB64 }
          },
          {
            type: 'text',
            text: `You are an expert resume writer. Rewrite the attached resume to be perfectly tailored for this job listing.

JOB: ${job.title} at ${job.company}
LOCATION: ${job.location}
DESCRIPTION:
${job.description?.slice(0, 1500) || 'No description available'}

RULES:
- Keep all facts truthful — only reorder, rephrase, and emphasize existing experience
- Mirror language from the job description naturally
- Move the most relevant experience to the top
- Quantify achievements where possible
- Keep it to one page max
- Output clean, formatted markdown ready to convert to PDF

Output ONLY the resume content in markdown. No explanation or preamble.`
          }
        ]
      }]
    : [{
        role: 'user',
        content: `You are an expert resume writer. Create a professional resume for this candidate applying for a job.

CANDIDATE: ${prefs.name || 'Candidate'}
SKILLS: ${prefs.skills || 'Not specified'}
EXPERIENCE: ${prefs.exp || '?'} years

JOB: ${job.title} at ${job.company}
DESCRIPTION: ${job.description?.slice(0, 1000) || ''}

Create a complete, professional resume tailored to this role.
Output ONLY the resume in markdown format.`
      }];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages
    })
  });

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

async function generateCoverLetter(job, prefs, resumeContent, claudeKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Write a compelling, personalized cover letter for this job application.

RESUME SUMMARY:
${resumeContent.slice(0, 800)}

JOB: ${job.title} at ${job.company}
LOCATION: ${job.location}
JOB DESCRIPTION:
${job.description?.slice(0, 1200) || 'Not provided'}

RULES:
- 3-4 paragraphs, conversational but professional
- First paragraph: hook that shows you know the company
- Middle: connect 2-3 specific resume points to the role
- Close: clear call to action
- Do NOT use generic openers like "I am writing to express my interest..."
- Mirror the company's tone (startup = energetic, enterprise = formal)
- Output in clean markdown

Output ONLY the cover letter. No explanation.`
      }]
    })
  });

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

async function savePDFs(resumeContent, coverContent, job, prefs) {
  // In production: use Vercel Blob Storage or similar
  // For now, return data URLs that the frontend can use to download
  // The PDF conversion happens client-side via the frontend
  const safeCompany = job.company.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const safeDate = new Date().toISOString().split('T')[0];

  return {
    resumeUrl: `/api/pdf?type=resume&job=${job.id}`,
    coverUrl: `/api/pdf?type=cover&job=${job.id}`,
    resumeMarkdown: resumeContent,
    coverMarkdown: coverContent
  };
}

function buildTags(job) {
  const tags = [];
  const desc = (job.description || '').toLowerCase();
  const ext = job.detected_extensions || {};

  if (ext.work_from_home || desc.includes('remote')) tags.push('Remote');
  if (desc.includes('hybrid')) tags.push('Hybrid');
  if (ext.schedule_type) tags.push(ext.schedule_type);
  else tags.push('Full-time');

  return tags;
}

function getLogoEmoji(company) {
  const map = {
    stripe: '💳', notion: '📝', figma: '🎨', google: '🔵', amazon: '📦',
    apple: '🍎', meta: '👥', netflix: '🎬', spotify: '🎵', airbnb: '🏠',
    uber: '🚗', lyft: '🟣', twitter: '🐦', linkedin: '💼', microsoft: '🪟',
    salesforce: '☁️', shopify: '🛍', slack: '💬', zoom: '📹', discord: '🎮',
    github: '🐙', gitlab: '🦊', vercel: '▲', linear: '📐', asana: '🔴',
    dropbox: '📦', datadog: '🐶', twilio: '📞', cloudflare: '🌐',
  };
  const key = company.toLowerCase().split(' ')[0];
  return map[key] || '🏢';
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
