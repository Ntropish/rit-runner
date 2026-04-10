const AUTH_URL = 'https://auth.trivorn.org';

export function checkTokenFromHash() {
  const hash = window.location.hash;
  if (hash.startsWith('#token=')) {
    const token = hash.slice(7);
    localStorage.setItem('token', token);
    window.history.replaceState(null, '', window.location.pathname);
  }
}

export function isAuthenticated(): boolean {
  return !!localStorage.getItem('token');
}

export function getToken(): string {
  return localStorage.getItem('token') || '';
}

export function login() {
  window.location.href = '/login';
}

export function logout() {
  localStorage.removeItem('token');
  window.location.href = '/login';
}

export async function fetchMe() {
  const res = await fetch('/api/me', {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error('Not authenticated');
  return res.json();
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...options.headers,
    },
  });
  if (res.status === 401) {
    const refreshRes = await fetch('/refresh', { method: 'POST' });
    if (refreshRes.ok) {
      const { access_token } = await refreshRes.json();
      localStorage.setItem('token', access_token);
      return fetch(path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${access_token}`,
          ...options.headers,
        },
      });
    }
    logout();
  }
  return res;
}
