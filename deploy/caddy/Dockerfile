# Caddy with the rate-limit module (the plain image has none). Versions are fixed so a rebuild gives the same server;
# raise them on purpose, one at a time, and read the release notes first.
FROM caddy:2.11.7-builder AS build
RUN xcaddy build v2.11.7 --with github.com/mholt/caddy-ratelimit@v0.1.0

FROM caddy:2.11.7
COPY --from=build /usr/bin/caddy /usr/bin/caddy
