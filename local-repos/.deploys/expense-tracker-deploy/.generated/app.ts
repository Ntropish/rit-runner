import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { db } from '../db'

const app = new Hono()

const authMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return c.json({ error: "Unauthorized" }, 401);
  const token = authHeader.replace("Bearer ", "");
  const res = await fetch("https://auth.trivorn.org/userinfo", { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) return c.json({ error: "Invalid token" }, 401);
  const user = await res.json();
  c.set("user", user);
  await next();
})

app.use('/api/*', authMiddleware)

app.get('/callback', async (c) => {
  const code = c.req.query("code");
  if (!code) return c.text("Missing code", 400);
  const cookie = c.req.header("Cookie") || "";
  const match = cookie.match(/pkce_verifier=([^;]+)/);
  if (!match) return c.text("Missing verifier", 400);
  const codeVerifier = match[1];
  const res = await fetch("https://auth.trivorn.org/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: "5a78c6ddab898e88131f7f582633b681", code, redirect_uri: "http://localhost:3001/callback", code_verifier: codeVerifier }) });
  const tokens = await res.json();
  const cookies: string[] = [];
  cookies.push("pkce_verifier=; HttpOnly; Path=/; Max-Age=0");
  if (tokens.refresh_token) {
    cookies.push("refresh_token=" + tokens.refresh_token + "; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000");
  }
  for (const ck of cookies) {
    c.header("Set-Cookie", ck, { append: true });
  }
  return c.redirect("http://localhost:5173/#token=" + tokens.access_token);
})

app.get('/login', async (c) => {
  const codeVerifier = crypto.randomUUID() + crypto.randomUUID();
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const codeChallenge = base64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const params = new URLSearchParams({ response_type: "code", client_id: "5a78c6ddab898e88131f7f582633b681", redirect_uri: "http://localhost:3001/callback", scope: "openid profile", code_challenge: codeChallenge, code_challenge_method: "S256" });
  c.header("Set-Cookie", "pkce_verifier=" + codeVerifier + "; HttpOnly; Path=/; SameSite=Lax");
  return c.redirect("https://auth.trivorn.org/authorize?" + params.toString());
})

app.post('/refresh', async (c) => {
  const cookie = c.req.header("Cookie") || "";
  const match = cookie.match(/refresh_token=([^;]+)/);
  if (!match) return c.json({ error: "No refresh token" }, 401);
  const refreshToken = match[1];
  const res = await fetch("https://auth.trivorn.org/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: "5a78c6ddab898e88131f7f582633b681", refresh_token: refreshToken }) });
  if (!res.ok) return c.json({ error: "Refresh failed" }, 401);
  const tokens = await res.json();
  if (tokens.refresh_token) {
    c.header("Set-Cookie", "refresh_token=" + tokens.refresh_token + "; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000");
  }
  return c.json({ access_token: tokens.access_token });
})

// /api routes
app.post('/api/categories', async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const id = crypto.randomUUID();
  db.query("INSERT INTO categories (id, name, color, user_sub) VALUES (?, ?, ?, ?)").run(id, body.name, body.color || "#6366f1", user.sub);
  const row = db.query("SELECT * FROM categories WHERE id = ?").get(id);
  return c.json(row, 201);
})
app.post('/api/expenses', async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const id = crypto.randomUUID();
  db.query("INSERT INTO expenses (id, amount, description, category_id, date, user_sub) VALUES (?, ?, ?, ?, ?, ?)").run(id, body.amount, body.description, body.category_id || null, body.date, user.sub);
  const row = db.query("SELECT e.*, c.name as category_name, c.color as category_color FROM expenses e LEFT JOIN categories c ON e.category_id = c.id WHERE e.id = ?").get(id);
  return c.json(row, 201);
})
app.delete('/api/categories/:id', async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const existing = db.query("SELECT * FROM categories WHERE id = ? AND user_sub = ?").get(id, user.sub);
  if (!existing) return c.json({ error: "Not found" }, 404);
  db.query("UPDATE expenses SET category_id = NULL WHERE category_id = ?").run(id);
  db.query("DELETE FROM categories WHERE id = ?").run(id);
  return c.json({ deleted: id });
})
app.delete('/api/expenses/:id', async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const existing = db.query("SELECT * FROM expenses WHERE id = ? AND user_sub = ?").get(id, user.sub);
  if (!existing) return c.json({ error: "Not found" }, 404);
  db.query("DELETE FROM expenses WHERE id = ?").run(id);
  return c.json({ deleted: id });
})
app.get('/api/categories', async (c) => {
  const user = c.get("user");
  const rows = db.query("SELECT c.*, COUNT(e.id) as expense_count FROM categories c LEFT JOIN expenses e ON c.id = e.category_id WHERE c.user_sub = ? GROUP BY c.id ORDER BY c.name").all(user.sub);
  return c.json(rows);
})
app.get('/api/expenses', async (c) => {
  const user = c.get("user");
  const category = c.req.query("category") || "";
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "";
  let sql = "SELECT e.*, c.name as category_name, c.color as category_color FROM expenses e LEFT JOIN categories c ON e.category_id = c.id WHERE e.user_sub = ?";
  const params: any[] = [user.sub];
  if (category) {
    sql += " AND e.category_id = ?";
    params.push(category);
  }
  if (from) {
    sql += " AND e.date >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND e.date <= ?";
    params.push(to);
  }
  sql += " ORDER BY e.date DESC, e.created_at DESC";
  const rows = db.query(sql).all(...params);
  return c.json(rows);
})
app.get('/api/me', async (c) => {
  const user = c.get("user");
  return c.json(user);
})
app.get('/api/summary', async (c) => {
  const user = c.get("user");
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "";
  let where = "WHERE e.user_sub = ?";
  const params: any[] = [user.sub];
  if (from) {
    where += " AND e.date >= ?";
    params.push(from);
  }
  if (to) {
    where += " AND e.date <= ?";
    params.push(to);
  }
  const total = db.query("SELECT COALESCE(SUM(amount), 0) as total FROM expenses e " + where).get(...params) as any;
  const byCategory = db.query("SELECT c.id, c.name, c.color, COALESCE(SUM(e.amount), 0) as total FROM categories c LEFT JOIN expenses e ON c.id = e.category_id AND e.user_sub = ? " + (from ? "AND e.date >= ? " : "") + (to ? "AND e.date <= ? " : "") + "WHERE c.user_sub = ? GROUP BY c.id ORDER BY total DESC").all(...params, user.sub);
  const byMonth = db.query("SELECT strftime('%Y-%m', e.date) as month, SUM(e.amount) as total FROM expenses e " + where + " GROUP BY month ORDER BY month DESC LIMIT 12").all(...params);
  return c.json({ total: total.total, byCategory, byMonth });
})
app.put('/api/expenses/:id', async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const existing = db.query("SELECT * FROM expenses WHERE id = ? AND user_sub = ?").get(id, user.sub);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json();
  db.query("UPDATE expenses SET amount = COALESCE(?, amount), description = COALESCE(?, description), category_id = COALESCE(?, category_id), date = COALESCE(?, date) WHERE id = ?").run(body.amount, body.description, body.category_id, body.date, id);
  const row = db.query("SELECT e.*, c.name as category_name, c.color as category_color FROM expenses e LEFT JOIN categories c ON e.category_id = c.id WHERE e.id = ?").get(id);
  return c.json(row);
})

export default app
