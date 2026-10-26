# The box a package server runs in: Node 22, Python with uv, mcpcost, nothing else. Built from
# the local tarball so the probe inside matches the one the board uses. Debian, not Alpine: the
# native binaries that npm packages and MCPB bundles carry are built against glibc.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 python3-pip \
  && pip3 install --no-cache-dir --break-system-packages uv \
  && rm -rf /var/lib/apt/lists/*
# Managed Pythons for PyPI servers, so an install does not download one each time.
ENV UV_PYTHON_INSTALL_DIR=/opt/uvpy UV_TOOL_DIR=/work/uv UV_TOOL_BIN_DIR=/work/bin
RUN uv python install 3.12 3.13
COPY mcpcost-*.tgz /tmp/
RUN npm install -g /tmp/mcpcost-*.tgz && rm /tmp/mcpcost-*.tgz && npm cache clean --force
COPY probe.mjs /app/probe.mjs
WORKDIR /work
