import { Database } from 'bun:sqlite';

const db = new Database('app.db');

db.run(`CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6366f1',
  user_sub TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.run(`CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  amount REAL NOT NULL,
  description TEXT NOT NULL,
  category_id TEXT,
  date TEXT NOT NULL,
  user_sub TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
)`);

db.run(`CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_sub)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_sub)`);

export { db };
