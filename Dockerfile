# Node runs the TypeScript sources directly via native type stripping, so there
# is no build stage and no compiled output — the image is source plus runtime
# dependencies. Type stripping needs Node 22.18+; pinned to 24 to match dev.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies change far less often than source, so installing them first keeps
# this layer cached across most deploys.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY shared/src ./shared/src

# scripts/ ships too: minting a facility invite is a shell command run against a
# running instance, and it is the only way a facility can register.
COPY scripts ./scripts

USER node

# The port comes from the environment — the platform decides it, not the image.
CMD ["node", "src/server.ts"]
