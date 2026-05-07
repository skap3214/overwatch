"""Top-level bot.py — Pipecat Cloud's base image looks for this file.

Re-exports the canonical `bot(runner_args)` entrypoint from
`overwatch_pipeline.bot`. All actual logic lives in the package.
"""

from overwatch_pipeline.bot import bot  # noqa: F401

if __name__ == "__main__":  # pragma: no cover
    from pipecat.runner.run import main

    main()
