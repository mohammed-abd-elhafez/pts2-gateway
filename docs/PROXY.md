# Reverse proxy: what it must do

The app speaks plain HTTP on 127.0.0.1:8080 and expects a TLS proxy in front. The proxy is where three things
belong that the app deliberately does not do.

1. **TLS.** Certificates, HTTP to HTTPS, HSTS.
2. **Rate limits.** Every request to `/pts/...` and `/v1/...` costs one database query to check the secret or the key,
   so a flood of wrong secrets can use up the 10-connection pool and stop real uploads. Limit per client address.
3. **No secrets in the proxy's access log.** The upload URL carries the station secret in its path.

## nginx example

```nginx
# one zone per door; controllers upload every minute or so, the client system polls a few times a minute
limit_req_zone $binary_remote_addr zone=pts:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=api:10m rate=120r/m;
limit_conn_zone $binary_remote_addr zone=perip:10m;

# log the path WITHOUT the secret: $uri would contain it, so log only the first segment
map $uri $safe_uri { ~^/(pts)(/|$) /$1/***; default $uri; }
log_format gateway '$remote_addr [$time_local] "$request_method $safe_uri" $status $body_bytes_sent $request_time';

server {
  listen 443 ssl http2;
  server_name gateway.example.com;
  access_log /var/log/nginx/gateway.log gateway;   # never the default 'combined' format
  add_header Strict-Transport-Security "max-age=31536000" always;
  add_header X-Content-Type-Options nosniff always;
  client_max_body_size 20m;                        # same as BODY_LIMIT_BYTES
  limit_conn perip 20;

  location /pts/ { limit_req zone=pts burst=60 nodelay; proxy_pass http://127.0.0.1:8080; proxy_request_buffering on; }
  location /v1/  { limit_req zone=api burst=60 nodelay; proxy_pass http://127.0.0.1:8080; }
  location /     { return 404; }                   # /healthz and /readyz are for the host, not the internet
}
```

Several controllers can share one mobile-network address, so start with these numbers and watch the 429s before tightening.
Keep the proxy on a different `access_log` format from the default: the default prints the full request line, secret included.
