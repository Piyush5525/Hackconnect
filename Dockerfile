# --- build the browser bundle (Yjs + Monaco) ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY scripts/build-client.mjs scripts/build-client.mjs
COPY src ./src
RUN npm ci --ignore-scripts && node scripts/build-client.mjs

# --- runtime ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4173
COPY package*.json ./
RUN apk add --no-cache su-exec && npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY lib ./lib
COPY bridge ./bridge
COPY public ./public
COPY --from=build /app/vendor ./vendor
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY server.mjs index.html app.js events-ui.js shell.js app.css projects-ui.js tracker-ui.js motion.js settings-ui.js call-ui.js logos.js workspace-ui.js chat-ui.js fx.js config.js net.js ./
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/.hackconnect && chown -R node:node /app
# The entrypoint starts as root only to fix ownership of a mounted data disk, then runs the app as the unprivileged "node" user.
EXPOSE 4173
# No VOLUME instruction: Railway rejects it. Mount a volume at /app/.hackconnect on the platform (Railway Volume / Render disk / compose volume).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
