"""Hermes Quest exposes only a dashboard surface, not agent tools or hooks."""


def register(ctx):
    """No agent registrations; Hermes discovers dashboard/ separately."""
