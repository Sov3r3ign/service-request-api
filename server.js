import express from 'express';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const PORT = 3000;

const CATEGORIES = ['facilities', 'it', 'hr', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const ALLOWED_TRANSITIONS = {
  open: ['in_progress'],
  in_progress: ['resolved'],
  resolved: ['closed'],
  closed: [],
};

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

app.get('/health', async (_req, res) => {
  const result = await pool.query('SELECT CURRENT_TIMESTAMP AS database_time');
  res.json({ status: 'ok', databaseTime: result.rows[0].database_time });
});

app.get('/api/requests', async (req, res) => {
  const { status, priority, category, search } = req.query;

  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status is invalid' });
  }

    if (priority && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: 'priority is invalid' });
  }
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'category is invalid' });
  }

  const clauses = [];
  const values = [];

  const addFilter = (sql, value) => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };

  if (status) addFilter('status = ?', status);
  if (priority) addFilter('priority = ?', priority);
  if (category) addFilter('category = ?', category);
    if (hasText(search)) {
    addFilter('(title ILIKE ? OR description ILIKE ?)', `%${search.trim()}%`);
    values.push(`%${search.trim()}%`);
    clauses[clauses.length - 1] = clauses[clauses.length - 1].replace('?', `$${values.length}`);
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT * FROM requests ${whereClause} ORDER BY created_at DESC`,
    values,
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

app.patch('/api/requests/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { title, description, category, priority, assignedTo, status } = req.body;

    if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }

  if ([title, description, category, priority, assignedTo, status].every((value) => value === undefined)) {
    return res.status(400).json({ error: 'provide at least one field to update' });
  }

  if ((title !== undefined && !hasText(title)) || (description !== undefined && !hasText(description))) {
    return res.status(400).json({ error: 'title and description cannot be empty' });
  }
  if (category !== undefined && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'category is invalid' });
  }
  if (priority !== undefined && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: 'priority is invalid' });
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status is invalid' });
  }
  if (assignedTo !== undefined && !hasText(assignedTo)) {
    return res.status(400).json({ error: 'assignedTo cannot be empty' });
  }
    if (status !== undefined) {
    const currentResult = await pool.query(
      'SELECT status FROM requests WHERE id = $1',
      [id],
    );

    if (currentResult.rowCount === 0) {
      return res.status(404).json({ error: 'request not found' });
    }

    const currentStatus = currentResult.rows[0].status;
    const isNoChange = status === currentStatus;
    const isAllowed = ALLOWED_TRANSITIONS[currentStatus].includes(status);

    if (!isNoChange && !isAllowed) {
      return res.status(409).json({
        error: `cannot move request from ${currentStatus} to ${status}`,
      });
    }
  }  if (status !== undefined) {
    const currentResult = await pool.query(
      'SELECT status FROM requests WHERE id = $1',
      [id],
    );

    if (currentResult.rowCount === 0) {
      return res.status(404).json({ error: 'request not found' });
    }

    const currentStatus = currentResult.rows[0].status;
    const isNoChange = status === currentStatus;
    const isAllowed = ALLOWED_TRANSITIONS[currentStatus].includes(status);

    if (!isNoChange && !isAllowed) {
      return res.status(409).json({
        error: `cannot move request from ${currentStatus} to ${status}`,
      });
    }
  }

  const result = await pool.query(
    `UPDATE requests
     SET title = COALESCE($1, title),
         description = COALESCE($2, description),
         category = COALESCE($3, category),
         priority = COALESCE($4, priority),
         assigned_to = COALESCE($5, assigned_to),
         status = COALESCE($6, status),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $7
     RETURNING *`,
    [
      title?.trim() ?? null,
      description?.trim() ?? null,
      category ?? null,
      priority ?? null,
      assignedTo?.trim() ?? null,
      status ?? null,
      id,
    ],
  );

    if (result.rowCount === 0) {
    return res.status(404).json({
      error: 'request not found'
    });
  }

  return res.json(result.rows[0]);
});

app.get('/api/dashboard', async (_req, res) => {
  const result = await pool.query(
    `SELECT
       count(*) FILTER (WHERE status IN ('open', 'in_progress'))::integer AS open,
       count(*) FILTER (WHERE status = 'resolved')::integer AS resolved,
       count(*) FILTER (WHERE status = 'closed')::integer AS closed,
       count(*)::integer AS total
     FROM requests`,
  );

  return res.json(result.rows[0]);
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