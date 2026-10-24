# Official Swift image, with only developer-side media/stdlib tools added.
FROM swift:6.2.4-noble
RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
