FROM oven/bun:1.3

# Install Docker CLI for pipeline steps that build/deploy containers
RUN apt-get update && apt-get install -y docker.io docker-compose-plugin && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile || bun install

COPY . .

EXPOSE 4580

CMD ["bun", "src/index.ts", "/data/repos"]
