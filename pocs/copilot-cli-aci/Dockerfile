# Absolute-minimum image for running GitHub Copilot CLI inside
# Azure Container Instances (ACI). ACI only runs linux/amd64, and
# GitHub publishes a native x64 Linux binary, so no emulation or
# translation layer is required.
FROM debian:bookworm-slim

# ca-certificates: TLS for the download and for Copilot's own network calls
# git: Copilot CLI shells out to git for repository context
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# Pin a specific release so the image is reproducible. Override with
# --build-arg COPILOT_VERSION=vX.Y.Z to bump it.
ARG COPILOT_VERSION=v1.0.80
RUN curl -fsSL \
      "https://github.com/github/copilot-cli/releases/download/${COPILOT_VERSION}/copilot-linux-x64.tar.gz" \
      -o /tmp/copilot.tar.gz \
    && tar -xzf /tmp/copilot.tar.gz -C /usr/local/bin \
    && rm /tmp/copilot.tar.gz \
    && chmod +x /usr/local/bin/copilot \
    && copilot --version

WORKDIR /workspace
CMD ["copilot"]
