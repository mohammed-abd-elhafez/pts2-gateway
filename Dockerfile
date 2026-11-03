FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# the simulator's calibration charts, read only when DEMO_SEED=true
COPY scripts/sim/data ./scripts/sim/data
# start command used on Render (see render.yaml); the default CMD below is unchanged
COPY deploy/render-start.sh ./render-start.sh
USER node
EXPOSE 8080
CMD ["node", "dist/src/server.js"]
