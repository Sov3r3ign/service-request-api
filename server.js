import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();
const PORT = 3000;

const CATEGORIES = ['facilities', 'it', 'hr', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

app.disable('x-powered-by');
app.use(express.json());

app.get('/health', async (_req, res) => {
  const result = await pool.query('SELECT CURRENT_TIMESTAMP AS database_time');
  res.json({ status: 'ok', databaseTime: result.rows[0].database_time });
});

app.get('/api/requests', async (_req, res) => {
  const result = await pool.query(
    'SELECT * FROM requests ORDER BY created_at DESC',
  );

  return res.json(result.rows);
});

app.post('/api/requests', async (req, res) => {
  // Read and validate the fields that define a service request.
  const {
    title,
    description,
    category,
    priority = 'medium',
    requesterName
  } = req.body;

  if (![title, description, category, requesterName].every(hasText)) {
    return res.status(400).json({
      error: 'title, description, category, and requesterName are required',
    });
  }

  if (!CATEGORIES.includes(category) || !PRIORITIES.includes(priority)) {
    return res.status(400).json({
      error: 'category or priority is invalid'
    });
  }

  // Save the request to PostgreSQL
  const result = await pool.query(
    `INSERT INTO requests
      (title, description, category, priority, requester_name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      title.trim(),
      description.trim(),
      category,
      priority,
      requesterName.trim()
    ]
  );

  return res.status(201).json(result.rows[0]);
});

app.use((_req, res) => {
  res.status(404).json({ error: 'route not found' });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`Service request API listening on port ${PORT}`);
});