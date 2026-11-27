# Unmark — production image, built on Hermes by deploy/deploy.sh.
# NEXT_PUBLIC_* come from .env.build at build time; no runtime secrets.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# postinstall copies the onnxruntime-web wasm files into public/ort.
COPY scripts ./scripts
RUN npm ci
COPY . .
COPY .env.build .env.production
ENV NODE_OPTIONS=--max-old-space-size=1024 NEXT_TELEMETRY_DISABLED=1
RUN npx next build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
RUN rm -f .env .env.production .env.build
USER node
EXPOSE 3000
CMD ["node", "server.js"]
