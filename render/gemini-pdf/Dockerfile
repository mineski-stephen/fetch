# syntax=docker/dockerfile:1
#
# Container image for the Gemini brief-extraction proxy, built for Render.
# Standard library only, so there is no requirements.txt and no build step.

FROM python:3.12-slim

# PYTHONUNBUFFERED        -> logs stream straight to Render's log viewer
# PYTHONDONTWRITEBYTECODE -> no stray .pyc files in the image
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY gemini_proxy.py gemini_client.py brief_spec.py extractors.py prompt.md ./

# Run as an unprivileged user — never as root.
RUN useradd --create-home --uid 10001 appuser
USER appuser

# Render injects PORT at runtime (default 10000); the app binds 0.0.0.0:$PORT.
EXPOSE 10000

# Local-only liveness probe; Render uses the health check path from render.yaml.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import os,sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8000')+'/health',timeout=4).status==200 else 1)"

CMD ["python", "gemini_proxy.py"]
