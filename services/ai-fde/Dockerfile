# ---------------------------------------------------------------------------
#  AI-FDE: the ontology-aware assistant.
#  Talks to the ontology service over HTTP and to Ollama (or Azure OpenAI) for
#  the model. It holds no database credentials beyond chat persistence.
# ---------------------------------------------------------------------------
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY app ./app

RUN useradd --create-home --uid 10002 aifde && chown -R aifde:aifde /app
USER aifde

EXPOSE 4100
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4100"]
