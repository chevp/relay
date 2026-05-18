# Dockerfile — runs `relay serve` against this default-game folder.
#
# Build:   docker build -t nuna-default-game .
# Run:     docker run --rm -p 3001:3001 nuna-default-game
# Verify:  curl http://localhost:3001/discover.json

FROM node:20-alpine

RUN apk add --no-cache curl \
 && npm install -g @nuna/relay@^0.4.0

WORKDIR /game
COPY . /game

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3001/health || exit 1

CMD ["relay", "serve", "--host", "0.0.0.0", "--port", "3001"]