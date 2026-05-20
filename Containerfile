# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM rust:1.91-slim-trixie AS builder

WORKDIR /app

# Install build deps (needed for image crate C components)
RUN apt-get update && apt-get install -y pkg-config && rm -rf /var/lib/apt/lists/*

# Cache dependencies by building a stub binary first.
# At this stage there's no src/lib.rs and no handlers.rs, so rust-embed's
# RustEmbed derive never runs — only the deps get downloaded & compiled.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && \
    echo 'fn main(){}' > src/main.rs && \
    cargo build --release --locked && \
    rm -rf src

# Build the real binary
COPY src    ./src
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
ENV PORT=80

EXPOSE 80

CMD ["photo-viewer"]
