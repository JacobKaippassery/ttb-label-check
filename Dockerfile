# Single-stage on purpose.
#
# The server runs TypeScript directly via tsx rather than compiling to JS, so a
# multi-stage build would save little and add a step where the deployed artifact
# stops matching the reviewed source. For a prototype whose whole point is that
# the compliance logic is auditable, "what runs is what you read" is worth more
# than a smaller image.
#
# node:22-slim rather than alpine: sharp ships prebuilt binaries for glibc, and
# alpine's musl forces a source build that is slow and occasionally broken.
FROM node:22-slim

WORKDIR /app

# Dependencies first so this layer caches across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The frontend is compiled to static files that Express serves itself, so the
# deployed container is one process on one port with nothing to proxy.
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# ANTHROPIC_API_KEY is supplied at runtime by the platform's secret store.
# It is deliberately not baked into the image.
CMD ["npm", "start"]
