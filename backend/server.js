const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getDocument, GlobalWorkerOptions } = require('pdfjs-dist/legacy/build/pdf.mjs');
GlobalWorkerOptions.workerSrc = '';

dotenv.config();

const REQUIRED_ENV = ['GEMINI_API_KEY', 'BASE_PERSONA', 'RESUME_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`[FATAL] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

let resumeText = '';
const RESUME_TTL_MS = 20 * 60 * 1000; // 20 minutes

const toGdriveDownload = (url) => {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return `https://drive.google.com/uc?export=download&id=${match[1]}`;
  const idParam = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParam) return `https://drive.google.com/uc?export=download&id=${idParam[1]}`;
  return url;
};

const extractPdfText = async (arrayBuffer) => {
  const data = { data: new Uint8Array(arrayBuffer) };
  const doc = await getDocument({ ...data, useWorkerFetch: false, isEvalSupported: false }).promise;
  const pages = await Promise.all(
    Array.from({ length: doc.numPages }, (_, i) =>
      doc.getPage(i + 1).then(p => p.getTextContent()).then(c => c.items.map(x => x.str).join(' '))
    )
  );
  return pages.join('\n').trim();
};

const fetchResume = async () => {
  const rawUrl = process.env.RESUME_URL;
  if (!rawUrl) throw new Error('RESUME_URL env var is not set.');

  const isGdrive = rawUrl.includes('drive.google.com');
  const fetchUrl = isGdrive ? toGdriveDownload(rawUrl) : rawUrl;

  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${fetchUrl}`);

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/pdf') || isGdrive || rawUrl.toLowerCase().endsWith('.pdf')) {
    const buf = await res.arrayBuffer();
    return extractPdfText(buf);
  }

  const data = await res.json();
  return JSON.stringify(data, null, 2);
};

const loadResume = async () => {
  resumeText = await fetchResume();
  console.log(`[resume] Loaded (${resumeText.length} chars). Next refresh in ${RESUME_TTL_MS / 60000} min.`);
};

const scheduleResumeRefresh = () => {
  setInterval(async () => {
    try {
      resumeText = await fetchResume();
      console.log(`[resume] Refreshed (${resumeText.length} chars).`);
    } catch (err) {
      console.warn(`[resume] Refresh failed: ${err.message}. Keeping previous content.`);
    }
  }, RESUME_TTL_MS);
};

const greetings = require('./config/greetings.json').greetings;
const contacts = require('./config/contacts.json').contacts;
const farewells = require('./config/farewells.json').farewells;

const app = express();
app.set('trust proxy', 1);


const corsOptions = {
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  optionsSuccessStatus: 204,
};

app.options(/.*/, cors(corsOptions));
app.use(cors(corsOptions));

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(bodyParser.json());

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes.' }
});

const INJECTION_PATTERNS = [
  /ignore (previous|all|above|prior)/i,
  /you are now/i,
  /system prompt/i,
];

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'portfolio-backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const questionRaw = req.body?.question;

    if (typeof questionRaw !== 'string' || questionRaw.trim().length === 0) {
      return res.status(400).json({ error: 'question must be a non-empty string' });
    }

    if (questionRaw.trim().length > 2000) {
      return res.status(400).json({ error: 'Message too long. Please keep questions under 2000 characters.' });
    }

    if (INJECTION_PATTERNS.some(p => p.test(questionRaw))) {
      return res.status(400).json({ error: 'Invalid input.' });
    }

    const question = questionRaw.trim().toLowerCase();

    const isGreeting = [
      'hello', 'hey', 'hi there', 'greetings', 'howdy',
      'salutations', "what's up", 'yo', 'hiya',
      'good day', "how's it going", 'hi'
    ].some(greet => question.startsWith(greet));

    const isFarewell = [
      'goodbye', 'bye', 'see you later', 'later', 'cya',
      'adios', 'farewell', 'peace out', 'take care',
      'have a good one'
    ].some(farewell => question.startsWith(farewell));

    const isContact = [
      'contact', 'email', 'phone', 'reach', 'linkedin',
      'github', 'twitter', 'social'
    ].some(contact => question.includes(contact));

    if (isGreeting) {
      return res.json({ answer: greetings[Math.floor(Math.random() * greetings.length)] });
    }

    if (isFarewell) {
      return res.json({ answer: farewells[Math.floor(Math.random() * farewells.length)] });
    }

    if (isContact) {
      return res.json({ answer: contacts[Math.floor(Math.random() * contacts.length)] });
    }

    const model = genAI.getGenerativeModel({
      model: process.env.MODEL || 'gemini-2.5-flash',
      systemInstruction: `${process.env.BASE_PERSONA}\n\nResume:\n${resumeText}`,
    });

    const result = await model.generateContent(questionRaw.trim());
    const answer = result.response.text();
    if (!answer) {
      throw new Error('Empty response from AI service');
    }

    return res.json({ answer });
  } catch (error) {
    console.error('[/api/chat]', error.status || 'ERR', error.message);

    if (error.status === 429) {
      return res.status(429).json({ error: 'Rate limit reached. Please try again shortly.' });
    }
    if (error.status >= 500) {
      return res.status(502).json({ error: 'AI service temporarily unavailable.' });
    }
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.use((err, req, res, next) => {
  console.error('[global]', err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Something went wrong. Please try again later.' });
  }
});

const PORT = process.env.PORT || 5003;

loadResume().then(() => {
  scheduleResumeRefresh();
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}).catch((err) => {
  console.error('[FATAL] Failed to load resume:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

module.exports = app;
