"""Crisp interactive test runner for product-analytics-v1.

A small Typer CLI that discovers tests via pytest's own collector, lets you
cherry-pick them in a Textual tree, and runs them in-process while a Rich
dashboard streams pass/fail live.

Entry point:  python -m tests.runner
"""
