# Caddy with the rate-limit module (the plain image has none). Pin the exact versions once you have chosen them:
# `docker compose images` prints the digests of what was built.
FROM caddy:2-builder AS build
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

FROM caddy:2
COPY --from=build /usr/bin/caddy /usr/bin/caddy
