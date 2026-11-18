# Cloud Run Job `airlock-scorer` (docs/05-FIREBASE-AND-GCP.md §9). Build and deploy only with the owner's
# permission, on the separate evaluation project. The job command still requires --live --i-have-permission
# and AIRLOCK_BENCH_LIVE_OK=yes (set on the job by the owner).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY airlock_scorer ./airlock_scorer
ENTRYPOINT ["python", "-m", "airlock_scorer", "job"]
