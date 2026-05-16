import os
import json
import argparse
import sys

def init_openswarmpp(target_dir: str = None):
    if target_dir is None:
        target_dir = os.getcwd()

    config_dir = os.path.join(target_dir, ".openswarmpp")
    if os.path.exists(config_dir):
        print(f"Directory {config_dir} already exists.")
        return False

    os.makedirs(config_dir, exist_ok=True)

    default_config = {
        "project_name": os.path.basename(target_dir),
        "default_model": "sonnet",
        "default_provider": "anthropic",
        "allowed_tools": ["read_file", "write_file", "list_files", "run_command", "git_status", "create_sub_agent"],
        "max_turns": 20,
        "token_efficiency": {
            "use_summarization": True,
            "summarize_after_tokens": 50000,
            "prompt_caching": True
        },
        "agents": [
            {"name": "Architect", "mode": "architect", "model": "opus"},
            {"name": "Coder", "mode": "coder", "model": "sonnet"},
            {"name": "Reviewer", "mode": "reviewer", "model": "haiku"}
        ]
    }

    config_path = os.path.join(config_dir, "config.json")
    with open(config_path, "w") as f:
        json.dump(default_config, f, indent=4)

    # Create empty folders for extensions
    os.makedirs(os.path.join(config_dir, "tools"), exist_ok=True)
    os.makedirs(os.path.join(config_dir, "modes"), exist_ok=True)

    print(f"Initialized .openswarmpp at {config_dir}")
    return True

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="OpenSwarm++ CLI")
    subparsers = parser.add_subparsers(dest="command")

    init_parser = subparsers.add_parser("init", help="Initialize .openswarmpp configuration")
    init_parser.add_argument("path", nargs="?", default=".", help="Path to initialize in")

    args = parser.parse_args()

    if args.command == "init":
        init_openswarmpp(args.path)
    else:
        parser.print_help()
