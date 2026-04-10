import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DollarSign, Tag, BarChart3 } from 'lucide-react';
import { NavShellLayout } from '@trivorn/nav-shell';
import '@trivorn/nav-shell/src/NavShell.css';
import { ThemeClient } from '@trivorn/theme-client';
import { checkTokenFromHash, isAuthenticated, login, logout, fetchMe, apiFetch } from './api.js';
import './styles.css';

checkTokenFromHash();

if (!isAuthenticated()) {
  login();
}

const queryClient = new QueryClient();

let themeClient: ThemeClient | null = null;

function getThemeClient(): ThemeClient {
  if (!themeClient) {
    themeClient = new ThemeClient({
      authCoreUrl: 'https://auth.trivorn.org',
      getAccessToken: () => localStorage.getItem('token') || '',
    });
  }
  return themeClient;
}

const navItems = [
  { icon: DollarSign, label: 'Expenses', href: '/' },
  { icon: Tag, label: 'Categories', href: '/categories' },
  { icon: BarChart3, label: 'Summary', href: '/summary' },
];

function RootLayout() {
  const { data: user } = useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
  });

  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  useEffect(() => {
    if (user) {
      getThemeClient().apply();
    }
  }, [user]);

  if (!user) return null;

  return (
    <NavShellLayout
      items={navItems}
      user={{
        name: user.name || user.preferred_username || 'User',
        avatarUrl: user.picture,
      }}
      currentPath={currentPath}
      isAdmin={user.groups?.includes('admin')}
      onLogout={logout}
      authDashboardUrl="https://auth.trivorn.org"
    >
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '1.5rem 1rem' }}>
        <Outlet />
      </div>
    </NavShellLayout>
  );
}

// Expenses page
function ExpensesPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses'],
    queryFn: () => apiFetch('/api/expenses').then(r => r.json()),
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => apiFetch('/api/categories').then(r => r.json()),
  });

  const createExpense = useMutation({
    mutationFn: (data: any) => apiFetch('/api/expenses', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['summary'] });
      setShowForm(false);
      setAmount('');
      setDescription('');
      setCategoryId('');
    },
  });

  const deleteExpense = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/expenses/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['summary'] });
    },
  });

  return (
    <div>
      <div className="page-header">
        <h2>Expenses</h2>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : '+ Add Expense'}
        </button>
      </div>

      {showForm && (
        <form className="form-card" onSubmit={e => {
          e.preventDefault();
          createExpense.mutate({ amount: parseFloat(amount), description, category_id: categoryId || undefined, date });
        }}>
          <div className="form-row">
            <input type="number" step="0.01" placeholder="Amount" value={amount} onChange={e => setAmount(e.target.value)} required />
            <input type="text" placeholder="Description" value={description} onChange={e => setDescription(e.target.value)} required />
          </div>
          <div className="form-row">
            <select value={categoryId} onChange={e => setCategoryId(e.target.value)}>
              <option value="">No category</option>
              {categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} required />
            <button type="submit" className="btn btn-primary">Save</button>
          </div>
        </form>
      )}

      <div className="expense-list">
        {expenses.map((exp: any) => (
          <div key={exp.id} className="expense-item">
            <div className="expense-info">
              <span className="expense-amount">${exp.amount.toFixed(2)}</span>
              <span className="expense-desc">{exp.description}</span>
              {exp.category_name && (
                <span className="category-badge" style={{ backgroundColor: exp.category_color + '20', color: exp.category_color }}>
                  {exp.category_name}
                </span>
              )}
            </div>
            <div className="expense-meta">
              <span className="expense-date">{exp.date}</span>
              <button className="btn btn-danger btn-sm" onClick={() => deleteExpense.mutate(exp.id)}>Delete</button>
            </div>
          </div>
        ))}
        {expenses.length === 0 && <p className="empty-state">No expenses yet. Add one above.</p>}
      </div>
    </div>
  );
}

// Categories page
function CategoriesPage() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#6366f1');

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => apiFetch('/api/categories').then(r => r.json()),
  });

  const createCategory = useMutation({
    mutationFn: (data: any) => apiFetch('/api/categories', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      setName('');
      setColor('#6366f1');
    },
  });

  const deleteCategory = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      qc.invalidateQueries({ queryKey: ['expenses'] });
    },
  });

  return (
    <div>
      <h2>Categories</h2>
      <form className="form-card" onSubmit={e => {
        e.preventDefault();
        createCategory.mutate({ name, color });
      }}>
        <div className="form-row">
          <input type="text" placeholder="Category name" value={name} onChange={e => setName(e.target.value)} required />
          <input type="color" value={color} onChange={e => setColor(e.target.value)} />
          <button type="submit" className="btn btn-primary">Add</button>
        </div>
      </form>

      <div className="category-list">
        {categories.map((cat: any) => (
          <div key={cat.id} className="category-item">
            <div className="category-info">
              <span className="category-dot" style={{ backgroundColor: cat.color }} />
              <span>{cat.name}</span>
              <span className="category-count">{cat.expense_count} expenses</span>
            </div>
            <button className="btn btn-danger btn-sm" onClick={() => deleteCategory.mutate(cat.id)}>Delete</button>
          </div>
        ))}
        {categories.length === 0 && <p className="empty-state">No categories yet.</p>}
      </div>
    </div>
  );
}

// Summary page
function SummaryPage() {
  const { data: summary } = useQuery({
    queryKey: ['summary'],
    queryFn: () => apiFetch('/api/summary').then(r => r.json()),
  });

  if (!summary) return <div>Loading...</div>;

  return (
    <div>
      <h2>Summary</h2>
      <div className="summary-total">
        <span>Total Spending</span>
        <span className="total-amount">${summary.total.toFixed(2)}</span>
      </div>

      <h3>By Category</h3>
      <div className="summary-categories">
        {summary.byCategory.map((cat: any) => (
          <div key={cat.id} className="summary-cat-row">
            <div className="summary-cat-info">
              <span className="category-dot" style={{ backgroundColor: cat.color }} />
              <span>{cat.name}</span>
            </div>
            <span className="summary-cat-amount">${cat.total.toFixed(2)}</span>
          </div>
        ))}
      </div>

      {summary.byMonth.length > 0 && (
        <>
          <h3>By Month</h3>
          <div className="summary-months">
            {summary.byMonth.map((m: any) => (
              <div key={m.month} className="summary-month-row">
                <span>{m.month}</span>
                <span className="summary-cat-amount">${m.total.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: ExpensesPage,
});

const categoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/categories',
  component: CategoriesPage,
});

const summaryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/summary',
  component: SummaryPage,
});

const routeTree = rootRoute.addChildren([indexRoute, categoriesRoute, summaryRoute]);
const router = createRouter({ routeTree });

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
