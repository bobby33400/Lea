# Image used by Lea's optional Docker sandbox backend (Windows/Linux/macOS).
# Build:  docker build -t lea-claude:latest docker/
#
# At runtime Lea mounts ONLY the task's project folder at /workspace and runs
# `claude` inside here, so file changes are confined to that folder.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep curl \
  && rm -rf /var/lib/apt/lists/*

# Install the Claude Code CLI.
RUN npm install -g @anthropic-ai/claude-code

# Auth is provided at runtime via env (Lea passes it through):
#   - Subscription: CLAUDE_CODE_OAUTH_TOKEN  (generate with `claude setup-token`)
#   - or API:       ANTHROPIC_API_KEY
WORKDIR /workspace
ENTRYPOINT []
