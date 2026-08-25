FROM node:22-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime

# Lets a deployed container name the commit it is running, so a rollout can be
# confirmed with one call instead of inferred from behaviour.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/kadera-malgo.sqlite
ENV GEMINI_MODEL=gemini-2.5-flash-lite
ENV MAX_QUESTION_LENGTH=350
ENV RATE_LIMIT_WINDOW_MS=60000
ENV RATE_LIMIT_MAX_REQUESTS=8
ENV STRICT_LATENCY_MODE=true
ENV EXPOSE_DIAGNOSTIC_APIS=false
ENV EXPOSE_DIAGNOSTIC_TOOLS=false
ENV MCP_ALLOWED_HOSTS=kadera-malgo.playmcp-endpoint.kakaocloud.io,kadera-malgo-2.playmcp-endpoint.kakaocloud.io,localhost,127.0.0.1,[::1]

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public

EXPOSE 3000
CMD ["node", "dist/http.js"]
