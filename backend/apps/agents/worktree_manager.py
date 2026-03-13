import asyncio
import os
import shutil
import logging

logger = logging.getLogger(__name__)

class WorktreeManager:
    def __init__(self, repo_root: str):
        self.repo_root = repo_root
        self.worktrees_dir = os.path.join(repo_root, ".worktrees")
        os.makedirs(self.worktrees_dir, exist_ok=True)

    async def create_worktree(self, branch_name: str) -> str:
        """Create a new git worktree and return its path."""
        worktree_path = os.path.join(self.worktrees_dir, branch_name)
        if os.path.exists(worktree_path):
            return worktree_path
        
        proc = await asyncio.create_subprocess_exec(
            "git", "worktree", "add", worktree_path, "-b", branch_name,
            cwd=self.repo_root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            proc = await asyncio.create_subprocess_exec(
                "git", "worktree", "add", worktree_path, branch_name,
                cwd=self.repo_root,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(f"Failed to create worktree: {stderr.decode()}")
        
        logger.info(f"Created worktree at {worktree_path} on branch {branch_name}")
        return worktree_path

    async def remove_worktree(self, branch_name: str) -> None:
        """Remove a git worktree."""
        worktree_path = os.path.join(self.worktrees_dir, branch_name)
        if not os.path.exists(worktree_path):
            return
        
        proc = await asyncio.create_subprocess_exec(
            "git", "worktree", "remove", worktree_path, "--force",
            cwd=self.repo_root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        logger.info(f"Removed worktree at {worktree_path}")

    async def list_worktrees(self) -> list[dict]:
        """List all worktrees with their branch and path info."""
        proc = await asyncio.create_subprocess_exec(
            "git", "worktree", "list", "--porcelain",
            cwd=self.repo_root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        
        worktrees = []
        current = {}
        for line in stdout.decode().strip().split("\n"):
            if line.startswith("worktree "):
                if current:
                    worktrees.append(current)
                current = {"path": line.split(" ", 1)[1]}
            elif line.startswith("HEAD "):
                current["head"] = line.split(" ", 1)[1]
            elif line.startswith("branch "):
                current["branch"] = line.split(" ", 1)[1].replace("refs/heads/", "")
            elif line == "":
                if current:
                    worktrees.append(current)
                    current = {}
        if current:
            worktrees.append(current)
        return worktrees

    async def delete_branch(self, branch_name: str) -> None:
        """Delete a local git branch."""
        proc = await asyncio.create_subprocess_exec(
            "git", "branch", "-D", branch_name,
            cwd=self.repo_root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode == 0:
            logger.info(f"Deleted branch {branch_name}")
        else:
            logger.warning(f"Could not delete branch {branch_name}: {stderr.decode().strip()}")

    async def cleanup_all_worktrees(self) -> None:
        """Remove all worktree directories and prune stale git worktree refs."""
        if os.path.exists(self.worktrees_dir):
            for entry in os.listdir(self.worktrees_dir):
                entry_path = os.path.join(self.worktrees_dir, entry)
                if os.path.isdir(entry_path):
                    shutil.rmtree(entry_path, ignore_errors=True)
            logger.info("Removed all worktree directories")

        proc = await asyncio.create_subprocess_exec(
            "git", "worktree", "prune",
            cwd=self.repo_root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        logger.info("Pruned stale git worktree refs")

    async def get_worktree_diff(self, branch_name: str) -> str:
        """Get the diff of uncommitted changes in a worktree."""
        worktree_path = os.path.join(self.worktrees_dir, branch_name)
        if not os.path.exists(worktree_path):
            return ""
        
        proc = await asyncio.create_subprocess_exec(
            "git", "diff", "HEAD",
            cwd=worktree_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        return stdout.decode()
