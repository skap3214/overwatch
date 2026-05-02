# Pipecat Cloud deploy artifact for the Overwatch orchestrator.
#
# Uses the official dailyco/pipecat-base image which:
#   - Provides the runtime that imports your bot.py and calls bot(runner_args)
#   - Wires the health check and shutdown signals Pipecat Cloud expects
#   - Runs the FastAPI server pipecat.runner.run sets up
#
# See: https://github.com/pipecat-ai/docs/blob/main/pipecat-cloud/fundamentals/agent-images.mdx

FROM dailyco/pipecat-base:latest

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# Build ID: 2026-05-02-v5-userchannel

# Install the project's dependencies using the lockfile.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

# Copy the bot entry + the orchestrator package.
COPY ./bot.py bot.py
COPY ./overwatch_pipeline ./overwatch_pipeline
