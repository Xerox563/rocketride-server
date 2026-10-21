"""Deliberate failure for the bracket teardown demo (demo branch only, never merged)."""


def test_teardown_demo_deliberate_failure():
    """Fail on purpose so the CI log shows whether the bracket's teardown runs after a failed step."""
    assert False, 'deliberate failure: demo of the bracket teardown (issue 2654, PR #2777)'
