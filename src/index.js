import express from 'express';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import OpenAI from 'openai';
import cors from 'cors';

const app = express();
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

app.use(express.json());
app.use(cors());

// Initialize database
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS stories (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        current_paragraph TEXT NOT NULL,
        chapter INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS story_branches (
        id SERIAL PRIMARY KEY,
        story_id INT REFERENCES stories(id),
        choice_index INT NOT NULL,
        description TEXT NOT NULL,
        generated_paragraph TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
  } finally {
    client.release();
  }
}

// Auth middleware
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Login/signup
app.post('/auth/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  const client = await pool.connect();
  try {
    let user = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (user.rows.length === 0) {
      user = await client.query(
        'INSERT INTO users (email) VALUES ($1) RETURNING *',
        [email]
      );
    }
    
    const userId = user.rows[0].id;
    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });
    
    // Create initial story
    const story = await client.query(
      `INSERT INTO stories (user_id, current_paragraph, chapter)
       VALUES ($1, $2, $3) RETURNING id`,
      [userId, 'Your adventure begins...', 1]
    );
    
    res.json({ token, userId, storyId: story.rows[0].id });
  } finally {
    client.release();
  }
});

// Get story
app.get('/story/:id', verifyToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const story = await client.query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    
    if (!story.rows.length) return res.status(404).json({ error: 'Story not found' });
    
    const storyData = story.rows[0];
    const choices = await client.query(
      'SELECT * FROM story_branches WHERE story_id = $1 ORDER BY choice_index',
      [req.params.id]
    );
    
    // If no choices exist, generate them
    if (choices.rows.length === 0) {
      const newChoices = await generateChoices(storyData.current_paragraph);
      await Promise.all(
        newChoices.map((desc, idx) =>
          client.query(
            'INSERT INTO story_branches (story_id, choice_index, description) VALUES ($1, $2, $3)',
            [req.params.id, idx, desc]
          )
        )
      );
      res.json({
        paragraph: storyData.current_paragraph,
        choices: newChoices,
        isLoading: false
      });
    } else {
      res.json({
        paragraph: storyData.current_paragraph,
        choices: choices.rows.map(r => r.description),
        isLoading: false
      });
    }
  } finally {
    client.release();
  }
});

// Make choice
app.post('/story/:id/choose', verifyToken, async (req, res) => {
  const { choiceIndex } = req.body;
  const client = await pool.connect();
  
  try {
    const branch = await client.query(
      'SELECT * FROM story_branches WHERE story_id = $1 AND choice_index = $2',
      [req.params.id, choiceIndex]
    );
    
    if (!branch.rows.length) return res.status(404).json({ error: 'Choice not found' });
    
    let nextParagraph = branch.rows[0].generated_paragraph;
    
    // If this choice hasn't been explored yet, generate the paragraph
    if (!nextParagraph) {
      const story = await client.query('SELECT current_paragraph FROM stories WHERE id = $1', [req.params.id]);
      const currentPara = story.rows[0].current_paragraph;
      nextParagraph = await generateNextParagraph(currentPara, branch.rows[0].description);
      
      await client.query(
        'UPDATE story_branches SET generated_paragraph = $1 WHERE id = $2',
        [nextParagraph, branch.rows[0].id]
      );
    }
    
    // Update story with new paragraph
    await client.query(
      'UPDATE stories SET current_paragraph = $1, chapter = chapter + 1, updated_at = NOW() WHERE id = $2',
      [nextParagraph, req.params.id]
    );
    
    // Delete old choices and generate new ones
    await client.query('DELETE FROM story_branches WHERE story_id = $1', [req.params.id]);
    const newChoices = await generateChoices(nextParagraph);
    
    await Promise.all(
      newChoices.map((desc, idx) =>
        client.query(
          'INSERT INTO story_branches (story_id, choice_index, description) VALUES ($1, $2, $3)',
          [req.params.id, idx, desc]
        )
      )
    );
    
    res.json({
      paragraph: nextParagraph,
      choices: newChoices,
      isLoading: false
    });
  } finally {
    client.release();
  }
});

// Create new story
app.post('/story/new', verifyToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const story = await client.query(
      `INSERT INTO stories (user_id, current_paragraph, chapter)
       VALUES ($1, $2, $3) RETURNING id`,
      [req.user.userId, 'Your new adventure begins...', 1]
    );
    res.json({ storyId: story.rows[0].id });
  } finally {
    client.release();
  }
});

// AI Functions
async function generateChoices(paragraph) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [
      {
        role: 'system',
        content: 'You are a creative story writer. Generate 3 distinct story choices based on the current paragraph. Return ONLY 3 short options (1 sentence each), separated by newlines. No numbering or extra text.'
      },
      {
        role: 'user',
        content: `Based on this paragraph, what are 3 possible next choices?\n\n${paragraph}`
      }
    ],
    temperature: 0.8,
    max_tokens: 200
  });
  
  return response.choices[0].message.content.split('\n').filter(c => c.trim()).slice(0, 3);
}

async function generateNextParagraph(currentParagraph, choice) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [
      {
        role: 'system',
        content: 'You are a creative storyteller. Write the next paragraph based on the current story and the reader\'s choice. Keep it engaging and around 150 words.'
      },
      {
        role: 'user',
        content: `Current paragraph:\n${currentParagraph}\n\nReader chose: ${choice}\n\nWrite the next paragraph:`
      }
    ],
    temperature: 0.9,
    max_tokens: 300
  });
  
  return response.choices[0].message.content;
}

// Start server
await initDB();
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));