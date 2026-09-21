# ---------------------------------------------------------------------------
#  Pipeline: captured TMS payloads -> raw tables -> views -> ontology -> lineage
#  Runs to completion and exits; the ontology service waits on that via
#  service_completed_successfully.
# ---------------------------------------------------------------------------
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# psycopg[binary] ships its own libpq wheel, so no build toolchain or
# libpq-dev is needed here.
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY pipeline ./pipeline

# Run as a non-root user; the container only ever reads the mounted snapshot.
RUN useradd --create-home --uid 10001 pipeline \
    && chown -R pipeline:pipeline /app
USER pipeline

CMD ["python", "-m", "pipeline.run"]
