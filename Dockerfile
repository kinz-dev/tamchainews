# No `# syntax=` directive on purpose: it makes BuildKit fetch a frontend image
# from Docker Hub before it will read this file, which turns a registry hiccup
# into a build that hangs with no output. Nothing here needs it.
FROM python:3.13-slim

# edge-tts is the only dependency, and it is pure Python: no build toolchain,
# no system packages beyond what the slim image already carries.
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py config.json ./
COPY web/ ./web/

# The archive is the only state, and it is what gives the reader a history
# past the three days upstream keeps.
RUN mkdir -p /app/data/archive && \
    useradd --create-home --uid 10001 tamchai && \
    chown -R tamchai:tamchai /app/data
USER tamchai

# config.json binds to loopback, which is right on a laptop and useless in a
# container: nothing outside could reach it. The port stays configurable.
ENV TAMCHAI_HOST=0.0.0.0 \
    TAMCHAI_PORT=8082 \
    PYTHONUNBUFFERED=1

EXPOSE 8082
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8082/api/health', timeout=4).status == 200 else 1)"

ENTRYPOINT ["python", "server.py"]
