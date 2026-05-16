import os
import subprocess
import logging
from typing import Optional

logger = logging.getLogger(__name__)

class GithubIntegration:
    @staticmethod
    def import_repository(url: str, target_dir: str) -> str:
        """Clone a github repository to target_dir using only git CLI."""
        try:
            if os.path.exists(target_dir) and os.listdir(target_dir):
                return f"Target directory {target_dir} is not empty."

            os.makedirs(target_dir, exist_ok=True)
            result = subprocess.run(
                ["git", "clone", url, "."],
                cwd=target_dir,
                capture_output=True,
                text=True,
                timeout=300
            )
            if result.returncode == 0:
                return f"Successfully imported repository from {url}"
            else:
                return f"Error cloning repository: {result.stderr}"
        except Exception as e:
            return f"Error importing repository: {e}"

    @staticmethod
    def push_changes(repo_dir: str, commit_message: str, branch: str = "main") -> str:
        """Stage, commit, and push changes to github."""
        try:
            # 1. Stage changes
            subprocess.run(["git", "add", "."], cwd=repo_dir, check=True)

            # 2. Commit
            # Need to ensure user.email and user.name are set if not globally set
            # For simplicity, assume they are or set them locally
            subprocess.run(["git", "config", "user.email", "openswarm@local"], cwd=repo_dir)
            subprocess.run(["git", "config", "user.name", "OpenSwarm"], cwd=repo_dir)

            result = subprocess.run(
                ["git", "commit", "-m", commit_message],
                cwd=repo_dir,
                capture_output=True,
                text=True
            )
            if result.returncode != 0:
                return f"Error committing changes: {result.stderr}"

            # 3. Push
            result = subprocess.run(
                ["git", "push", "origin", branch],
                cwd=repo_dir,
                capture_output=True,
                text=True,
                timeout=60
            )
            if result.returncode == 0:
                return "Successfully pushed changes to GitHub."
            else:
                return f"Error pushing to GitHub: {result.stderr}"
        except Exception as e:
            return f"Error pushing changes: {e}"
