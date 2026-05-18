from setuptools import setup, find_packages

# Exposes both `debug` (legacy) and `swarm_debug` (webapp-template convention; thin re-export).
setup(
    name="debug",
    version="0.1",
    packages=find_packages(),
    py_modules=["debug", "swarm_debug"]
)
