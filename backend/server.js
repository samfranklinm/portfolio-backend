const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const pdf = require('pdf-parse');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const helmet = require('helmet');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.set('trust proxy', 1);

// Update allowed origins to include your Render URL
const allowedOrigins = [
  'http://localhost:3000', 
  'http://localhost:5004',
  'http://localhost:5002',
  'http://localhost:5003', 
  'https://samfranklin.dev',
  process.env.RENDER_EXTERNAL_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['POST', 'OPTIONS'], // Add OPTIONS for preflight requests
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(helmet());

const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Too many requests from this IP, please try again after 10 minutes'
});

app.use(bodyParser.json());
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
    // Don't exit the process, but set a default value
    resumeText = 'Resume text temporarily unavailable.';
  }
};

// Add health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

loadResume();

function getSystemPrompts(resumeText) {
  const basePrompt = {
    role: "system", 
    content: `${process.env.BASE_PERSONA}`
  };
  
  const resumePrompt = {
    role: "system",
    content: `Resume: ${resumeText}`
  };
  
  return [basePrompt, resumePrompt];
}

const greetings = require('./config/greetings.json').greetings;
const contacts = require('./config/contacts.json').contacts;
const farewells = require('./config/farewells.json').farewells;

app.post('/api/chat', 
  chatLimiter,
  body('question').isString().trim().escape(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const question = req.body.question.trim().toLowerCase();
      const isGreeting = ["hello", "hey", "hi there", "greetings", "howdy", "salutations", "what's up", "yo", "hiya", "good day", "how's it going", "hi"].some(greet => question.startsWith(greet));
      const isFarewell = ["goodbye", "bye", "see you later", "later", "cya", "adios", "farewell", "peace out", "take care", "have a good one"].some(farewell => question.startsWith(farewell));
      const isContact = ['contact', 'email', 'phone', 'reach', 'linkedin', 'github', 'twitter', 'social'].some(contact => question.includes(contact));

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
        ...getSystemPrompts(resumeText),
        {
          role: "user",
          content: question
        }
      ];

      const response = await axios.post('https://api.x.ai/v1/chat/completions', {
        messages,
        model: "grok-beta",
        temperature: 0.7,
        stream: false
      }, {
        headers: {
          'Authorization': `Bearer ${XAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      const answer = response.data.choices[0].message.content;
      res.json({ answer });
      
    } catch (error) {
      console.error('Error in /api/chat:', error.response ? error.response.data : error.message);
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
      
      res.status(500).json({ error: errorMessage });
    }
  }
);

// Correctly formatted error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Something went wrong! Please try again later.' });
  }
});

// Start the Server
const PORT = process.env.PORT || 5003;
console.log(`Starting server...`);
console.log(`Environment PORT: ${process.env.PORT}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV}`);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
});

// Handle server shutdown gracefully
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