import app from './.generated/app.js';

const server = Bun.serve({
  port: 3001,
  fetch: app.fetch,
});

console.log(`Server running on http://localhost:${server.port}`);
