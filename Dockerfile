FROM oven/bun:1.3-debian

# Install Docker CLI from official Docker repo
RUN apt-get update && apt-get install -y ca-certificates curl gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock .npmrc ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc bun install --frozen-lockfile || bun install

COPY . .

EXPOSE 4580

CMD ["bun", "src/index.ts", "/data/repos"]
