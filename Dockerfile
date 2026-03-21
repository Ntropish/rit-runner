FROM oven/bun:1.3

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile || bun install

COPY . .

EXPOSE 4580

CMD ["bun", "src/index.ts", "/data/repos"]
