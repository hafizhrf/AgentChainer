# X-06: an Ubuntu 22.04 image to build the debug app and run the end-to-end tests locally, like CI's Ubuntu job.
#   docker build -t agentchainer-e2e scripts/e2e
#   docker run --rm -v "$PWD":/repo -v ac-e2e-target:/repo/target -v ac-e2e-cargo:/root/.cargo/registry \
#     agentchainer-e2e bash -c "pnpm install --frozen-lockfile && \
#       pnpm --filter @agentchainer/desktop tauri build --debug --no-bundle && \
#       xvfb-run -a node scripts/e2e/run.mjs --binary target/debug/agentchainer"
FROM ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl file git pkg-config xz-utils \
    libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
    webkit2gtk-driver xvfb dbus-x11 \
  && rm -rf /var/lib/apt/lists/*
# Node 24, as .node-version says, and pnpm through corepack (packageManager pins its version).
ARG NODE_VERSION=24.18.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 && corepack enable
ENV PATH=/root/.cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ARG TAURI_DRIVER_VERSION=2.1.0
RUN cargo install tauri-driver --version "${TAURI_DRIVER_VERSION}" --locked
WORKDIR /repo
