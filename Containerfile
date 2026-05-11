# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM rust:1.91-slim-trixie AS builder

WORKDIR /app

# Install build deps (needed for image crate C components)
RUN apt-get update && apt-get install -y pkg-config && rm -rf /var/lib/apt/lists/*

# Cache dependencies by building a stub binary first
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src static && \
    echo 'fn main(){}' > src/main.rs && \
    echo '' > static/index.html && \
    cargo build --release --locked && \
    rm -rf src static

# Build the real binary
COPY src   ./src
COPY static ./static
RUN touch src/main.rs && cargo build --release --locked

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/photo-viewer /usr/local/bin/photo-viewer

# Photos are mounted here at runtime
VOLUME ["/photos"]
ENV PHOTOS_DIR=/photos
ENV PORT=3000

EXPOSE 3000

CMD ["photo-viewer"]
