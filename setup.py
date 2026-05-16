from setuptools import setup, Extension

module = Extension('performance', sources=['backend/performance.c'])

setup(
    name='performance',
    version='1.0',
    description='Performance critical functions in C',
    ext_modules=[module]
)
