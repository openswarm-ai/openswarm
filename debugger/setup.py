from setuptools import setup, find_packages

# `py_modules` exposes BOTH `debug` (legacy import name used by OpenSwarm's
# own backend) and `swarm_debug` (the import name the webapp-template
# scaffold uses, matching the published-package convention `swarm-debug`).
# The `swarm_debug` module is a thin re-export of `debug` — see swarm_debug.py.
setup(
    name="debug",
    version="0.1",
    packages=find_packages(),
    py_modules=["debug", "swarm_debug"]
)
