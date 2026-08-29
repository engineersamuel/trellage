# syntax=docker/dockerfile:1

FROM node:bookworm-slim

RUN groupadd --gid 10002 app \
    && useradd --uid 10002 --gid 10002 --create-home --home-dir /home/app --shell /bin/bash app \
    && mkdir -p /workspace /data \
    && touch /workspace/.volume-seed /data/.volume-seed \
    && chown -R 10002:10002 /workspace /data /home/app

COPY scripts/app-entrypoint.sh /usr/local/bin/app-entrypoint.sh
RUN chmod 0555 /usr/local/bin/app-entrypoint.sh

ENV HOME=/tmp \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false \
    NODE_COMPILE_CACHE=/tmp/.cache/trellage/node-compile-cache \
    NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /workspace
USER 10002:10002
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/app-entrypoint.sh"]
