const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const pdf = require('pdf-parse');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const { body, validationResult } = require('express-validator');
const helmet = require('helmet');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = ['http://localhost:3000', 'http://localhost:5004','http://localhost:5002','http://localhost:5003', 'https://samfranklin.dev'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(helmet());

const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Too many requests from this IP, please try again after 10 minutes'
});

app.use(bodyParser.json());
const XAI_API_KEY = process.env.XAI_API_KEY;

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));

let resumeText = '';

const loadResume = async () => {
  try {
    const dataBuffer = fs.readFileSync('./resume.pdf');
    const data = await pdf(dataBuffer);
    resumeText = data.text;
    console.log('Resume loaded successfully.');
  } catch (error) {
    console.error('Error loading resume:', error);
  }
};

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

app.post('/api/chat', 
  chatLimiter,
  body('question').isString().trim().escape(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const session = req.session;
    const isNewSession = !session.history;

    if (isNewSession) {
      session.history = [];
    }

    const question = req.body.question.trim().toLowerCase();
    const isGreeting = ['hi', 'hello', 'hola', 'howdy', 'hey'].some(greet => question.startsWith(greet));

    if (isGreeting) {
      const greetingMessage = greetings[Math.floor(Math.random() * greetings.length)];
      return res.json({ answer: greetingMessage });
    }

    const messages = [
      ...getSystemPrompts(resumeText),
      ...session.history,
      {
        role: "user",
        content: question
      }
    ];

    try {
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
      
      session.history.push(
        { role: "user", content: question },
        { role: "assistant", content: answer }
      );

      if (session.history.length > 10) {
        session.history = session.history.slice(-10);
      }

      res.json({ 
        answer
      });
    } catch (error) {
      console.error('Error generating response:', error.response ? error.response.data : error.message);
      let errorMessage = 'An unexpected error occurred. Please try again later.';
      if (error.response) {
        if (error.response.status === 401) {
          errorMessage = 'Invalid API key. Please check your configuration.';
        } else if (error.response.status === 429) {
          errorMessage = 'Too many requests. Please try again later.';
        } else if (error.response.status === 500) {
          errorMessage = 'Server error. Please try again later.';
        }
      }
      res.status(500).json({ error: errorMessage });
    }
  }
);

app.use((err,res) => {
  console.error(err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Something went wrong! Please try again later.' });
  }
});

// Start the Server
const PORT = process.env.PORT || 5003;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
