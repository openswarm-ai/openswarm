"""Boot for a published app's runner VM (ENG-293). Downloads the app's bundle from storage by
APP_SLUG (read-only creds scoped to apps/*), unpacks it, installs the app's own requirements into
a local target dir, then serves backend + built frontend from one uvicorn on :8080. BUNDLE_VERSION
in env busts the on-disk copy on republish (the cloud stamps a fresh value into the machine)."""
import io
import json
import os
import subprocess
import sys
import tarfile

import boto3
from botocore.config import Config

WORKDIR = "/data/app"
SLUG = os.environ.get("APP_SLUG", "")
VERSION = os.environ.get("BUNDLE_VERSION", "0")
BUCKET = os.environ.get("TIGRIS_BUCKET", "openswarm-app-bundles")
STAMP = os.path.join(WORKDIR, ".bundle-version")


def s3():
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("AWS_ENDPOINT_URL_S3", "https://fly.storage.tigris.dev"),
        region_name=os.environ.get("TIGRIS_REGION", "auto"),
        aws_access_key_id=os.environ.get("TIGRIS_ACCESS_KEY_ID", ""),
        aws_secret_access_key=os.environ.get("TIGRIS_SECRET_ACCESS_KEY", ""),
        config=Config(signature_version="s3v4"),
    )


def fetch_and_unpack() -> None:
    obj = s3().get_object(Bucket=BUCKET, Key=f"apps/{SLUG}/bundle.tar.gz")
    data = obj["Body"].read()
    os.makedirs(WORKDIR, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            # A hostile bundle must not escape the workdir.
            if m.name.startswith(("/", "..")) or ".." in m.name.split("/"):
                continue
            tar.extract(m, WORKDIR)
    with open(STAMP, "w") as f:
        f.write(VERSION)


def ensure_bundle() -> bool:
    try:
        with open(STAMP) as f:
            if f.read().strip() == VERSION and os.path.isdir(os.path.join(WORKDIR, "backend")):
                return True
    except OSError:
        pass
    try:
        fetch_and_unpack()
        return True
    except Exception as e:
        print(f"[runner] bundle fetch failed: {type(e).__name__}: {e}", flush=True)
        return False


def install_requirements() -> None:
    req = os.path.join(WORKDIR, "backend", "requirements.txt")
    if not os.path.isfile(req):
        return
    # Best-effort: the base image preinstalls the template's deps; this covers apps that added more.
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--no-cache-dir", "-q", "-r", req],
        timeout=180, check=False,
    )


def main() -> None:
    if not SLUG or not ensure_bundle():
        # Serve an honest 503 shell instead of crash-looping the machine.
        os.execvp(sys.executable, [sys.executable, "-m", "uvicorn", "fallback:app", "--host", "0.0.0.0", "--port", "8080"])
    install_requirements()
    os.chdir(WORKDIR)
    sys.path.insert(0, WORKDIR)
    spec = {}
    try:
        with open(os.path.join(WORKDIR, "runspec.json")) as f:
            spec = json.load(f)
    except Exception:
        pass
    entry = "serve:app" if spec.get("has_backend") else "fallback:app"
    os.environ["PYTHONPATH"] = WORKDIR + ":" + os.environ.get("PYTHONPATH", "") + ":/srv/runner"
    os.execvp(sys.executable, [sys.executable, "-m", "uvicorn", entry, "--host", "0.0.0.0", "--port", "8080", "--app-dir", "/srv/runner"])


if __name__ == "__main__":
    main()
