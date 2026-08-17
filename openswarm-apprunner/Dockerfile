FROM python:3.12-slim
WORKDIR /srv/runner
# The webapp template's dependency set, preinstalled so most apps boot without a pip step.
RUN pip install --no-cache-dir "fastapi[standard]" "pydantic>=2.9.0" httpx uvicorn "typeguard==4.4.2" boto3
COPY boot.py serve.py fallback.py swarm_debug.py ./
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/srv/runner
EXPOSE 8080
CMD ["python", "boot.py"]
