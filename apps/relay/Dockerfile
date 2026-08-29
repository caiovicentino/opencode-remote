FROM node:22-alpine
WORKDIR /app

# the relay is a single-file, zero-native-dep service: build is trivial
COPY apps/relay/package.json ./
RUN npm install

COPY apps/relay/src ./src
ENV NODE_ENV=production
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]
