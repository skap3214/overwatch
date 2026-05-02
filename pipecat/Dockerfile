# Pipecat Cloud deploy artifact for the Overwatch orchestrator.
#
# Build:    docker build -t overwatch-orchestrator -f Dockerfile .
# Deploy:   pcc agent deploy
#
# Pipecat Cloud expects a Python image with the pipeline as the entrypoint.

FROM python:3.12-slim

# Build ID: 2026-05-02-v2
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1

# uv is the package manager for the project.
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /uvx /usr/local/bin/

WORKDIR /app

# Install dependencies first for layer caching.
COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen --no-install-project

# Copy the pipeline source.
COPY overwatch_pipeline/ ./overwatch_pipeline/

# Pipecat Cloud invokes `python -m overwatch_pipeline.bot` per pcc-deploy.toml.
CMD ["uv", "run", "python", "-m", "overwatch_pipeline.bot"]
