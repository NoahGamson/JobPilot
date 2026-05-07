// api/generate.js — Vercel serverless function
// Generates tailored resume + cover letter PDFs using Claude

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { job, prefs } = req.body;
  const claudeKey = process.env.ANTHROPIC_API_KEY;

  if (!claudeKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!job) return res.status(400).json({ error: 'No job data provided' });

  try {
    const resumeB64 = process.env.RESUME_B64;

    // Generate both in parallel where possible
    const [resumeMarkdown, coverMarkdown] = await Promise.all([
      generateResume(job, prefs, resumeB64, claudeKey),
      generateCoverLetter(job, prefs, claudeKey),
    ]);

    // Return markdown content — frontend converts to downloadable PDF
    return res.status(200).json({
      resumeMarkdown,
      coverMarkdown,
      // These endpoints serve the PDFs as server-rendered pages
      resumeUrl: `/api/pdf?type=resume&jobId=${job.id}`,
      coverUrl: `/api/pdf?type=cover&jobId=${job.id}`,
    });

  } catch (err) {
    console.error('generate error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function generateResume(job, prefs, resumeB64, claudeKey) {
  const hasResume = !!resumeB64;

  const systemPrompt = `You are an expert resume writer with 15 years of experience helping people land jobs at top companies.
Your resumes are concise, achievement-focused, and perfectly tailored to each role.
You NEVER fabricate experience or credentials. You only enhance and reframe what exists.`;

  let messages;

  if (hasResume) {
    messages = [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: resumeB64 }
        },
        {
          type: 'text',
          text: `Rewrite this resume to be perfectly tailored for the following job. 

═══ JOB DETAILS ═══
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.salary ? `Salary: ${job.salary}` : ''}

Job Description:
${job.description?.slice(0, 2000) || 'Not provided'}

═══ INSTRUCTIONS ═══
1. Keep ALL information truthful — only reorder, reframe, and emphasize existing experience
2. Mirror keywords from the job description naturally (don't keyword-stuff)
3. Move the most relevant experience and achievements to the top
4. Quantify achievements wherever the original has them
5. Trim anything irrelevant to make room for what matters
6. Use strong action verbs
7. Format: clean markdown with these sections in order:
   # [Full Name]
   [email] | [phone] | [location] | [linkedin if present]
   
   ## Summary
   [2-3 sentences max, tailored to this role]
   
   ## Experience
   [most relevant first]
   
   ## Skills
   [comma-separated, relevant to role]
   
   ## Education

Output ONLY the resume markdown. No explanation, no preamble.`
        }
      ]
    }];
  } else {
    messages = [{
      role: 'user',
      content: `Create a professional resume for this candidate.

CANDIDATE PROFILE:
- Name: ${prefs.name || 'Candidate Name'}
- Target role: ${prefs.titles}
- Skills: ${prefs.skills || 'Not provided'}
- Years of experience: ${prefs.exp || 'Not provided'}
- Location: ${prefs.locations || 'Not provided'}

TARGET JOB:
${job.title} at ${job.company}
${job.description?.slice(0, 1000) || ''}

Create a strong, ATS-friendly resume tailored to this role.
Format in clean markdown. Output ONLY the resume, no explanation.`
    }];
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: systemPrompt,
      messages
    })
  });

  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.content?.[0]?.text || '';
}

async function generateCoverLetter(job, prefs, claudeKey) {
  const systemPrompt = `You are an expert cover letter writer. You write compelling, human cover letters that don't sound AI-generated.
You avoid clichés like "I am writing to express my interest" and instead open with genuine insight about the company.
Every cover letter is unique, specific, and shows the candidate has actually researched the role.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 900,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Write a cover letter for this application.

CANDIDATE:
- Name: ${prefs.name || 'The Candidate'}
- Skills: ${prefs.skills || 'Not provided'}
- Experience: ${prefs.exp || '?'} years

JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}

Job Description:
${job.description?.slice(0, 1500) || 'Not provided'}

COVER LETTER REQUIREMENTS:
- 3 short paragraphs (no more than 4)
- Para 1: Open with a specific observation about ${job.company} or the role — something that shows you've done your homework. Then connect it to why you're excited.
- Para 2: Pick 2-3 specific skills/achievements from the candidate's background and connect them directly to the role's needs. Be concrete.
- Para 3: Brief, confident close. Express enthusiasm, mention you'd love to discuss further.
- Tone: Match the company — startups should feel energetic and direct, large corps more formal
- NO: "I am writing to...", "I believe I would be a great fit", "I am passionate about..."
- Max 280 words total

Format in clean markdown:
[Date]

Hiring Team at ${job.company},

[3 paragraphs]

[Name]

Output ONLY the cover letter. No explanation.`
      }]
    })
  });

  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.content?.[0]?.text || '';
}
