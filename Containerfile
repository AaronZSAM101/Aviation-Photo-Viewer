# ── Stage 1: Frontend (TypeScript + React + antd → Vite build) ────────────────
FROM node:22-alpine AS frontend

WORKDIR /app/frontend

# Cache npm dependencies separately from the source copy
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
RUN npm run build

# ── Stage 2: Backend (Rust + actix-web) ───────────────────────────────────────
FROM rust:1.91-slim-trixie AS builder

WORKDIR /app

# Install build deps (needed for image crate C components)
RUN apt-get update && apt-get install -y pkg-config && rm -rf /var/lib/apt/lists/*

# Cache dependencies by building a stub binary first — only the deps get
# downloaded & compiled, so the real build below stays fast on source changes.
COPY backend/Cargo.toml backend/Cargo.lock backend/build.rs ./
RUN mkdir -p src && \
    echo 'fn main(){}' > src/main.rs && \
    cargo build --release --locked && \
    rm -rf src

# Build the real binary
COPY backend/src ./src
ARG PHOTO_VIEWER_VERSION=
ARG PHOTO_VIEWER_VERSION_SOURCE=
ENV PHOTO_VIEWER_VERSION=${PHOTO_VIEWER_VERSION}
ENV PHOTO_VIEWER_VERSION_SOURCE=${PHOTO_VIEWER_VERSION_SOURCE}
RUN touch src/main.rs && cargo build --release --locked

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM debian:trixie-slim

# curl 是给 podman 的健康检查用的：livenessProbe 会被翻译成 CMD-SHELL curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates libimage-exiftool-perl curl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/photo-viewer /usr/local/bin/photo-viewer
COPY --from=frontend /app/frontend/dist /app/frontend/dist

# Photos are mounted here at runtime
VOLUME ["/photos"]
ENV PHOTOS_DIR=/photos
ENV FRONTEND_DIR=/app/frontend/dist
ENV PORT=80
ENV HOST=0.0.0.0
ENV READ_ONLY=false

EXPOSE 80

CMD ["photo-viewer"]
