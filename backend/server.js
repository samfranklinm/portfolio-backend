const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const pdf = require('pdf-parse');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const helmet = require('helmet');
const dotenv = require('dotenv');
dotenv.config();

const OpenAI = require('openai').default; // Access default export for CommonJS :contentReference[oaicite:9]{index=9}

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5004',
  'http://localhost:5002',
  'http://localhost:5003',
  'https://samfranklin.dev',
  process.env.RENDER_EXTERNAL_URL
].filter(Boolean); // Filter out undefined :contentReference[oaicite:10]{index=10}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(helmet());
app.use(bodyParser.json());

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many requests from this IP, please try again after 10 minutes'
}); // Rate limit per 15 minutes per IP :contentReference[oaicite:11]{index=11}

app.use(chatLimiter);

const XAI_API_KEY = process.env.XAI_API_KEY;
let resumeText = '';

const loadResume = async () => {
  try {
    const dataBuffer = fs.readFileSync('./resume.pdf');
    const data = await pdf(dataBuffer);
    resumeText = data.text;
    console.log('Resume loaded successfully.');
  } catch (error) {
    console.error('Error loading resume:', error);
    resumeText = 'Resume text temporarily unavailable.';
  }
};

loadResume(); // Preload resume on startup :contentReference[oaicite:12]{index=12}

const greetings = require('./config/greetings.json').greetings;
const contacts = require('./config/contacts.json').contacts;
const farewells = require('./config/farewells.json').farewells;

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.post(
  '/api/chat',
  body('question').isString().trim().escape(), // Sanitize input :contentReference[oaicite:13]{index=13}
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const questionRaw = req.body.question;
      const question = questionRaw.trim().toLowerCase();
      const isGreeting = [
        'hello', 'hey', 'hi there', 'greetings', 'howdy',
        'salutations', "what's up", 'yo', 'hiya',
        'good day', "how's it going", 'hi'
      ].some(greet => question.startsWith(greet)); // Detect friendly greetings :contentReference[oaicite:14]{index=14}

      const isFarewell = [
        'goodbye', 'bye', 'see you later', 'later', 'cya',
        'adios', 'farewell', 'peace out', 'take care',
        'have a good one'
      ].some(farewell => question.startsWith(farewell)); // Detect farewells :contentReference[oaicite:15]{index=15}

      const isContact = [
        'contact', 'email', 'phone', 'reach', 'linkedin',
        'github', 'twitter', 'social'
      ].some(contact => question.includes(contact)); // Detect contact requests :contentReference[oaicite:16]{index=16}

      if (isGreeting) {
        const greetingMessage = greetings[Math.floor(Math.random() * greetings.length)];
        return res.json({ answer: greetingMessage });
      }

      if (isFarewell) {
        const farewellMessage = farewells[Math.floor(Math.random() * farewells.length)];
        return res.json({ answer: farewellMessage });
      }

      if (isContact) {
        const contactMessage = contacts[Math.floor(Math.random() * contacts.length)];
        return res.json({ answer: contactMessage });
      }

      const messages = [
        {
          role: 'system',
          content: `${process.env.BASE_PERSONA}`
        },
        {
          role: 'system',
          content: `Resume: ${resumeText}`
        },
        {
          role: 'user',
          content: questionRaw
        }
      ];

      const client = new OpenAI({
        apiKey: XAI_API_KEY,
        baseURL: 'https://api.x.ai/v1'
      });
      const completion = await client.chat.completions.create({
        model: 'grok-3-mini-fast-beta',
        temperature: 0.8,
        messages
      });

      if (
        !completion.choices ||
        !completion.choices[0] ||
        !completion.choices[0].message ||
        typeof completion.choices[0].message.content !== 'string'
      ) {
        throw new Error('Unexpected response structure from X.AI Grok API');
      }
      const answer = completion.choices[0].message.content;

      return res.json({ answer });
    } catch (error) {
      console.error(
        'Error in /api/chat:',
        error.response ? error.response.data : error.message
      );
      let errorMessage = 'An unexpected error occurred. Please try again later.';
      if (error.response) {
        switch (error.response.status) {
          case 401:
            errorMessage = 'Invalid API key. Please check your configuration.';
            break;
          case 429:
            errorMessage = 'Too many requests. Please try again later.';
            break;
          case 500:
            errorMessage = 'Server error. Please try again later.';
            break;
        }
      }
      return res.status(500).json({ error: errorMessage });
    }
  }
);

// Global error handler :contentReference[oaicite:21]{index=21}
app.use((err, req, res, next) => {
  console.error('Global error handler:', err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Something went wrong! Please try again later.' });
  }
});

const PORT = process.env.PORT || 5003;
console.log(`Starting server...`);
console.log(`Environment PORT: ${process.env.PORT}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV}`);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = app;
