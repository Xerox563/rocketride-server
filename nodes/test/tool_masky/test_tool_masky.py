# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Offline unit tests for the tool_masky node.

No engine, no network. ``rocketlib`` / ``ai.common.*`` / ``depends`` /
``requests`` are replaced by stubs just long enough to import the node, then
sys.modules is restored. ``depends`` and ``requests`` (imported lazily by the
node at call time) are re-installed per test by the ``stubs`` fixture.
"""

from __future__ import annotations

import json
import sys
import types
from email.utils import format_datetime
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

_NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'tool_masky'

_STUBS = (
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.utils',
    'ai.common.config',
    'ai.common.tools',
    'depends',
    'requests',
    'tool_masky',
)


def _check_credential_resolved(logicalType, field, value, connConfig=None):
    """Stand-in for ai.common.config.check_credential_resolved: rejects unfilled placeholders."""
    if isinstance(value, str) and ('${' in value or '<REDACTED>' in value):
        raise ValueError(f'{logicalType}.{field} is an unfilled placeholder')


def _make_requests():
    req = types.ModuleType('requests')
    req.RequestException = type('RequestException', (Exception,), {})
    req.Timeout = type('Timeout', (req.RequestException,), {})
    req.request = lambda *a, **k: None
    return req


def _make_depends():
    dep = types.ModuleType('depends')
    dep.calls = []
    dep.load_depends = lambda path=None, *a, **k: dep.calls.append(path)
    return dep


def _install_stubs() -> None:
    rl = types.ModuleType('rocketlib')
    rl.IInstanceBase = type('IInstanceBase', (), {})
    rl.IGlobalBase = type('IGlobalBase', (), {})
    rl.OPEN_MODE = type('OPEN_MODE', (), {'CONFIG': 'config', 'SOURCE': 'source'})
    for name in ('debug', 'error', 'warning'):
        setattr(rl, name, lambda *a, **k: None)
    sys.modules['rocketlib'] = rl

    for name in ('ai', 'ai.common', 'ai.common.utils', 'ai.common.config', 'ai.common.tools'):
        sys.modules[name] = types.ModuleType(name)
    sys.modules['ai'].__path__ = []
    sys.modules['ai.common'].__path__ = []
    sys.modules['ai.common.tools'].ToolsBase = type('ToolsBase', (), {})

    def parse_bool(v):
        if isinstance(v, str):
            return v.strip().lower() in {'true', '1', 'yes'}
        return bool(v)

    sys.modules['ai.common.utils'].parse_bool = parse_bool

    class _Config:
        @staticmethod
        def getNodeConfig(*_a, **_k):
            return {}

    sys.modules['ai.common.config'].Config = _Config
    sys.modules['ai.common.config'].check_credential_resolved = _check_credential_resolved
    sys.modules['depends'] = _make_depends()
    sys.modules['requests'] = _make_requests()

    pkg = types.ModuleType('tool_masky')
    pkg.__path__ = [str(_NODE_DIR)]
    sys.modules['tool_masky'] = pkg


_saved = {n: sys.modules.get(n) for n in _STUBS}
_install_stubs()
try:
    from tool_masky import IGlobal as IGlobalMod  # noqa: E402
    from tool_masky import IInstance as IInstanceMod  # noqa: E402,F401
    from tool_masky import masky_core as core  # noqa: E402
    from tool_masky.masky_client import MaskyClient  # noqa: E402
    from tool_masky.masky_core import MaskyError  # noqa: E402
    from tool_masky.masky_driver import MaskyDriver  # noqa: E402
finally:
    for _n, _m in _saved.items():
        if _m is None:
            sys.modules.pop(_n, None)
        else:
            sys.modules[_n] = _m
    for _n in [k for k in sys.modules if k.startswith('tool_masky.')]:
        sys.modules.pop(_n, None)

KEY = 'mky_SECRET_KEY_123'  # gitleaks:allow -- fake key; tests assert it never appears in errors


# ---------------------------------------------------------------------------
# Fakes and fixtures
# ---------------------------------------------------------------------------


class FakeClient:
    """Fake MaskyClient that counts calls."""

    def __init__(self, voices=None, avatars=None, public=None):
        self.voices = voices or []
        self.avatars = avatars if avatars is not None else {'avatars': [], 'owner': {}}
        self.public = public or []
        self.calls = []
        self.closed = False

    def list_voices(self):
        self.calls.append('voices')
        return self.voices

    def list_avatars(self):
        self.calls.append('avatars')
        return self.avatars

    def list_public_avatars(self):
        self.calls.append('public')
        return self.public

    def close(self):
        self.closed = True


class FakeResp:
    """Minimal response object."""

    def __init__(self, status=200, body=None, text='', headers=None):
        self.status_code = status
        self._body = body
        self.text = text
        self.headers = headers or {}
        self.content = b'x' if (body is not None or text) else b''

    def json(self):
        if self._body is None:
            raise ValueError('no json')
        return self._body


def _driver(client=None, **kw):
    return MaskyDriver(server_name=kw.pop('server_name', 'masky'), client=client or FakeClient(), **kw)


@pytest.fixture
def stubs(monkeypatch):
    """Install per-test depends/requests stubs (the node imports them lazily)."""
    dep = _make_depends()
    req = _make_requests()
    monkeypatch.setitem(sys.modules, 'depends', dep)
    monkeypatch.setitem(sys.modules, 'requests', req)
    # IGlobal.beginGlobal imports rocketlib lazily (for isCancelled).
    monkeypatch.setitem(sys.modules, 'rocketlib', types.ModuleType('rocketlib'))
    return types.SimpleNamespace(depends=dep, requests=req)


@pytest.fixture
def http(stubs, monkeypatch):
    """Control requests.request; returns state with a queue of responses."""
    state = {'calls': [], 'resp': FakeResp(200, {}), 'queue': [], 'exc': None, 'sleeps': [], 'requests': stubs.requests}

    def fake(method, url, **kw):
        state['calls'].append({'method': method, 'url': url, **kw})
        if state['exc']:
            raise state['exc']
        if state['queue']:
            return state['queue'].pop(0)
        return state['resp']

    stubs.requests.request = fake
    # No real sleeping in retries.
    # The default `sleep` is bound at def time, so patch the keyword default.
    monkeypatch.setitem(core.with_retries.__kwdefaults__, 'sleep', lambda s: state['sleeps'].append(s))
    return state


# ---------------------------------------------------------------------------
# 1. _tool_query
# ---------------------------------------------------------------------------


ALL_TOOLS = [
    'list_avatars',
    'get_avatar',
    'create_avatar',
    'train_avatar',
    'set_avatar_public',
    'get_stream_identity',
    'set_stream_identity',
    'list_voices',
    'set_avatar_voice',
    'list_looks',
    'add_look',
    'speak',
    'generate_video',
    'generate_image',
    'edit_image',
    'get_generation',
    'estimate_cost',
    'create_conversation',
    'set_conversation_visibility',
    'send_turn',
    'get_turns',
    'set_conversation_look',
    'bind_agent',
    'get_binding',
    'unbind_agent',
]


def test_tool_query_lists_all_25_tools():
    tools = _driver(settings={'allow_delete': True})._tool_query()
    assert [t['name'] for t in tools] == [f'masky.{n}' for n in ALL_TOOLS]
    assert len(tools) == 25
    for t in tools:
        assert t['description']
        assert t['inputSchema']['type'] == 'object'


def test_tool_query_default_hides_unbind_agent():
    tools = _driver()._tool_query()
    assert [t['name'] for t in tools] == [f'masky.{n}' for n in ALL_TOOLS if n != 'unbind_agent']
    assert len(tools) == 24


def test_tool_query_custom_server_name():
    tools = _driver(server_name='avatars', settings={'allow_delete': True})._tool_query()
    assert [t['name'] for t in tools] == [f'avatars.{n}' for n in ALL_TOOLS]


# ---------------------------------------------------------------------------
# 2. Validation (no HTTP)
# ---------------------------------------------------------------------------


def test_unknown_tool_names_available(http):
    d = _driver(MaskyClient(KEY))
    with pytest.raises(ValueError) as ei:
        d._tool_invoke(tool_name='masky.nope', input_obj={})
    assert all(f'masky.{n}' in str(ei.value) for n in ALL_TOOLS)
    assert http['calls'] == []


def test_non_dict_input_type_error(http):
    d = _driver(MaskyClient(KEY))
    with pytest.raises(TypeError):
        d._tool_invoke(tool_name='masky.list_voices', input_obj=['x'])
    assert http['calls'] == []


def test_list_voices_non_string_query(http):
    d = _driver(MaskyClient(KEY))
    with pytest.raises(ValueError):
        d._tool_invoke(tool_name='masky.list_voices', input_obj={'query': 5})
    assert http['calls'] == []


# ---------------------------------------------------------------------------
# 3. list_voices
# ---------------------------------------------------------------------------

VOICES = [
    {'id': 'v1', 'name': 'Alice British', 'source': 'preset'},
    {'id': 'v2', 'name': 'My Clone', 'source': 'custom'},
    {'voiceId': 'v3', 'name': 'Bob'},
    {'name': 'No Id'},
]


def _voices(**args):
    return _driver(FakeClient(voices=VOICES))._tool_invoke(tool_name='masky.list_voices', input_obj=args)


def test_list_voices_shaping_and_skip_missing_id():
    out = _voices()
    assert out['count'] == 3
    assert out['voices'] == [
        {'voice_id': 'v1', 'name': 'Alice British', 'kind': 'preset'},
        {'voice_id': 'v2', 'name': 'My Clone', 'kind': 'custom'},
        {'voice_id': 'v3', 'name': 'Bob', 'kind': 'preset'},
    ]


def test_list_voices_include_custom_false():
    assert [v['voice_id'] for v in _voices(include_custom=False)['voices']] == ['v1', 'v3']


def test_list_voices_include_custom_string_false():
    assert [v['voice_id'] for v in _voices(include_custom='false')['voices']] == ['v1', 'v3']


def test_list_voices_query_case_insensitive():
    assert [v['voice_id'] for v in _voices(query='BRIT')['voices']] == ['v1']


# ---------------------------------------------------------------------------
# 4. list_avatars
# ---------------------------------------------------------------------------

OWN = {
    'avatars': [
        {
            'avatarId': 'a1',
            'displayName': 'Ava',
            'voiceId': 'v1',
            'publiclyRenderable': True,
            'avatarImageUrl': 'https://cdn.example/a1.png',
            'avatarOwnerTwitchUsername': 'ava_t',
        },
        {'avatarId': 'a2', 'avatarImageUrl': 'https://cdn.example/a2.png'},
        {'displayName': 'no id'},
    ],
    'owner': {'username': 'me'},
}
PUBLIC = [
    {'avatarId': 'a2', 'displayName': 'dup', 'avatarImageUrl': 'https://cdn.example/dup.png'},
    {
        'avatarId': 'p1',
        'displayName': 'Pub',
        'publiclyRenderable': True,
        'avatarImageUrl': 'https://cdn.example/p1.png',
    },
]


def _avatars(client=None, **kw):
    args = kw.pop('args', {})
    d = _driver(client or FakeClient(avatars=OWN, public=PUBLIC), **kw)
    return d._tool_invoke(tool_name='masky.list_avatars', input_obj=args)


def test_list_avatars_shaping():
    out = _avatars()
    assert out['count'] == 2
    a1, a2 = out['avatars']
    assert a1 == {
        'avatar_id': 'a1',
        'name': 'Ava',
        'handle': 'ava_t',
        'voice_id': 'v1',
        'public': True,
        'own': True,
        'image_url': 'https://cdn.example/a1.png',
    }
    assert a2['name'] == 'a2' and a2['handle'] == 'me' and a2['voice_id'] is None and a2['public'] is False


def test_list_avatars_include_public_merges_without_duplicates():
    client = FakeClient(avatars=OWN, public=PUBLIC)
    out = _avatars(client, args={'include_public': True})
    assert [a['avatar_id'] for a in out['avatars']] == ['a1', 'a2', 'p1']
    assert out['avatars'][2]['own'] is False
    assert 'public' in client.calls


def test_list_avatars_public_not_fetched_by_default():
    client = FakeClient(avatars=OWN, public=PUBLIC)
    _avatars(client)
    assert 'public' not in client.calls


def test_list_avatars_no_media_urls():
    out = _avatars(args={'include_public': True}, include_media_urls=False)

    def keys(o):
        if isinstance(o, dict):
            for k, v in o.items():
                yield k
                yield from keys(v)
        elif isinstance(o, list):
            for v in o:
                yield from keys(v)

    assert 'image_url' not in set(keys(out))
    assert 'http' not in json.dumps(out)


# ---------------------------------------------------------------------------
# 5. error_for_status and client error mapping
# ---------------------------------------------------------------------------


def _call(http, resp=None, exc=None):
    http['resp'] = resp
    http['exc'] = exc
    with pytest.raises(MaskyError) as ei:
        MaskyClient(KEY).list_voices()
    return ei.value


def test_auth_errors_401(http):
    e = _call(http, FakeResp(401, {'error': 'nope'}))
    assert 'ROCKETRIDE_MASKY_KEY' in str(e) and 'ROCKETRIDE_MASKY_API_KEY' not in str(e)
    assert e.status == 401
    assert KEY not in str(e)


def test_auth_errors_403_is_a_refusal_not_a_bad_key(http):
    e = _call(http, FakeResp(403, {'error': 'nope'}))
    assert 'Masky refused access to /voices' in str(e) and 'nope' in str(e)
    assert 'rejected the API key' not in str(e)
    assert e.status == 403
    assert KEY not in str(e)


def test_error_for_status_401_mentions_env():
    e = core.error_for_status(401, {}, method='GET', path='/voices')
    assert 'ROCKETRIDE_MASKY_KEY' in str(e) and e.status == 401


def test_error_for_status_403_names_path_and_masky_text_not_the_key():
    e = core.error_for_status(403, {'error': 'not your avatar'}, method='GET', path='/avatars/A')
    assert 'Masky refused access to /avatars/A' in str(e) and 'not your avatar' in str(e)
    assert 'rejected' not in str(e) and e.status == 403


def test_402_insufficient_credits(http):
    e = _call(http, FakeResp(402, {}))
    assert 'insufficient credits' in str(e)
    assert KEY not in str(e)


def test_error_for_status_402_includes_credit_numbers():
    e = core.error_for_status(402, {'requiredCredits': 12.5, 'availableCredits': 3}, method='POST', path='/x')
    assert '12.5' in str(e) and '3' in str(e) and e.status == 402


def test_500_includes_detail_and_status(http):
    e = _call(http, FakeResp(500, {'error': 'boom'}))
    assert 'boom' in str(e) and '500' in str(e)
    assert KEY not in str(e)


def test_timeout_maps_to_masky_error(http):
    e = _call(http, exc=http['requests'].Timeout('slow'))
    assert isinstance(e, MaskyError)
    assert KEY not in str(e)


def test_request_exception_maps_and_hides_key(http):
    e = _call(http, exc=http['requests'].RequestException(f'failed with {KEY}'))
    assert KEY not in str(e)


def test_authorization_header_and_public_without_auth(http):
    http['resp'] = FakeResp(200, {'voices': []})
    MaskyClient(KEY).list_voices()
    assert http['calls'][-1]['headers']['Authorization'] == f'Bearer {KEY}'
    assert http['calls'][-1]['url'] == 'https://masky.ai/api/voices'

    http['resp'] = FakeResp(200, {'avatars': []})
    MaskyClient(KEY).list_public_avatars()
    assert 'Authorization' not in http['calls'][-1]['headers']
    assert http['calls'][-1]['url'].endswith('/avatars/public')


# ---------------------------------------------------------------------------
# 6. Retry policy
# ---------------------------------------------------------------------------


def test_retry_after_integer_seconds():
    assert core.retry_after_seconds('7') == 7.0
    assert core.retry_after_seconds(' 2 ') == 2.0


def test_retry_after_http_date():
    now = 1_000_000.0
    when = format_datetime(datetime.fromtimestamp(now + 10, tz=timezone.utc), usegmt=True)
    assert core.retry_after_seconds(when, now=now) == pytest.approx(10.0)
    past = format_datetime(datetime.fromtimestamp(now - 50, tz=timezone.utc), usegmt=True)
    assert core.retry_after_seconds(past, now=now) == 0.0


@pytest.mark.parametrize('value', [None, '', 'soon', 'not a date'])
def test_retry_after_garbage_is_none(value):
    assert core.retry_after_seconds(value) is None


def test_retry_after_capped_and_negative_clamped():
    assert core.retry_after_seconds('9999') == core.MAX_RETRY_AFTER_SEC
    assert core.retry_after_seconds('-5') == 0.0
    far = format_datetime(datetime.now(timezone.utc) + timedelta(days=1), usegmt=True)
    assert core.retry_after_seconds(far) == core.MAX_RETRY_AFTER_SEC


def _retry(responses, sleeps):
    seq = list(responses)
    calls = []

    def send():
        calls.append(1)
        return seq.pop(0)

    out = core.with_retries(
        send,
        status_of=lambda r: r.status_code,
        retry_after_of=lambda r: r.headers.get('Retry-After'),
        sleep=sleeps.append,
    )
    return out, len(calls)


def test_with_retries_429_then_200_honors_retry_after():
    sleeps = []
    out, n = _retry([FakeResp(429, {}, headers={'Retry-After': '4'}), FakeResp(200, {})], sleeps)
    assert out.status_code == 200 and n == 2
    assert sleeps == [4.0]


def test_with_retries_503_exhausts_with_backoff():
    sleeps = []
    out, n = _retry([FakeResp(503, {}), FakeResp(503, {}), FakeResp(503, {})], sleeps)
    assert out.status_code == 503 and n == 3
    assert sleeps == [1.0, 2.0]


def test_with_retries_400_not_retried():
    sleeps = []
    out, n = _retry([FakeResp(400, {})], sleeps)
    assert out.status_code == 400 and n == 1 and sleeps == []


def test_client_429_with_retry_after_then_200(http):
    http['queue'] = [FakeResp(429, {}, headers={'Retry-After': '2'}), FakeResp(200, {'voices': [{'id': 'v1'}]})]
    assert MaskyClient(KEY).list_voices() == [{'id': 'v1'}]
    assert len(http['calls']) == 2
    assert http['sleeps'] == [2.0]


def test_client_persistent_429_maps_to_rate_limit_error(http):
    http['resp'] = FakeResp(429, {})
    with pytest.raises(MaskyError) as ei:
        MaskyClient(KEY).list_voices()
    assert ei.value.status == 429 and len(http['calls']) == 3
    assert http['sleeps'] == [1.0, 2.0]


class ClosableResp(FakeResp):
    """FakeResp that records whether the retry loop released it."""

    closed = False

    def close(self):
        self.closed = True


@pytest.mark.parametrize(
    ('status', 'method', 'expected'),
    [
        (429, 'GET', True),
        (503, 'GET', True),
        (500, 'get', True),
        (404, 'GET', False),
        (200, 'GET', False),
        (429, 'POST', True),
        (429, 'PUT', True),
        (429, 'DELETE', True),
        (500, 'POST', False),
        (502, 'POST', False),
        (503, 'PUT', False),
        (504, 'DELETE', False),
    ],
)
def test_should_retry_by_method(status, method, expected):
    assert core.should_retry(status, method) is expected


def test_should_retry_defaults_to_get():
    assert core.should_retry(503) is True and core.should_retry(429) is True


def test_with_retries_post_5xx_not_retried_but_429_is():
    sleeps = []
    seq = [ClosableResp(502, {}), ClosableResp(202, {})]
    calls = []

    def send():
        calls.append(1)
        return seq.pop(0)

    out = core.with_retries(
        send, status_of=lambda r: r.status_code, retry_after_of=lambda r: None, sleep=sleeps.append, method='POST'
    )
    assert out.status_code == 502 and len(calls) == 1 and sleeps == []


def test_with_retries_closes_discarded_responses_only():
    sleeps = []
    first, second, last = ClosableResp(429, {}), ClosableResp(503, {}), ClosableResp(200, {})
    seq = [first, second, last]
    out = core.with_retries(
        lambda: seq.pop(0), status_of=lambda r: r.status_code, retry_after_of=lambda r: None, sleep=sleeps.append
    )
    assert out is last
    assert first.closed and second.closed
    assert not last.closed  # the returned response is the caller's to read


def test_client_post_5xx_is_sent_once_and_raises(http):
    first = ClosableResp(502, {'error': 'bad gateway'})
    http['queue'] = [first, ClosableResp(202, {'ok': True})]
    with pytest.raises(MaskyError) as ei:
        MaskyClient(KEY).train_avatar('A')
    assert len(http['calls']) == 1 and http['calls'][0]['method'] == 'POST'
    assert http['sleeps'] == []
    assert ei.value.status == 502
    assert 'may still have been accepted' in str(ei.value) and 'was not resent' in str(ei.value)
    assert KEY not in str(ei.value)


@pytest.mark.parametrize('method_call', ['train_avatar', 'delete_binding'])
def test_client_write_5xx_never_retried(http, method_call):
    http['resp'] = FakeResp(503, {})
    with pytest.raises(MaskyError) as ei:
        getattr(MaskyClient(KEY), method_call)('A')
    assert len(http['calls']) == 1 and ei.value.status == 503


def test_client_post_429_is_retried_then_succeeds(http):
    limited = ClosableResp(429, {}, headers={'Retry-After': '2'})
    http['queue'] = [limited, FakeResp(200, {'ok': True})]
    assert MaskyClient(KEY).train_avatar('A') == {'ok': True}
    assert [c['method'] for c in http['calls']] == ['POST', 'POST']
    assert http['sleeps'] == [2.0]
    assert limited.closed


def test_client_get_503_still_retried_and_discarded_responses_closed(http):
    first, second = ClosableResp(503, {}), ClosableResp(503, {})
    http['queue'] = [first, second, FakeResp(200, {'voices': [{'id': 'v1'}]})]
    assert MaskyClient(KEY).list_voices() == [{'id': 'v1'}]
    assert len(http['calls']) == 3 and http['sleeps'] == [1.0, 2.0]
    assert first.closed and second.closed


def test_client_get_persistent_5xx_surfaces_http_error(http):
    http['resp'] = FakeResp(503, {'error': 'down'})
    e = _call(http, http['resp'])
    assert e.status == 503 and 'down' in str(e) and len(http['calls']) == 3
    assert 'may still have been accepted' not in str(e)


def test_client_post_timeout_warns_request_may_have_been_accepted(http):
    http['exc'] = http['requests'].Timeout('slow')
    with pytest.raises(MaskyError) as ei:
        MaskyClient(KEY).train_avatar('A')
    assert 'may still have been accepted' in str(ei.value)
    assert 'Try again shortly' not in str(ei.value)
    assert len(http['calls']) == 1 and KEY not in str(ei.value)


def test_client_get_timeout_keeps_try_again_wording(http):
    e = _call(http, exc=http['requests'].Timeout('slow'))
    assert 'Try again shortly' in str(e) and 'may still have been accepted' not in str(e)


# ---------------------------------------------------------------------------
# 7. resolve_api_key
# ---------------------------------------------------------------------------


def test_resolve_api_key_configured_wins(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_MASKY_KEY', 'envkey')
    assert core.resolve_api_key(' cfgkey ') == 'cfgkey'


def test_resolve_api_key_blank_falls_back_to_env(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_MASKY_KEY', ' envkey ')
    assert core.resolve_api_key('') == 'envkey'
    assert core.resolve_api_key('   ') == 'envkey'
    assert core.resolve_api_key(None) == 'envkey'


def test_resolve_api_key_old_env_name_not_read(monkeypatch):
    monkeypatch.delenv('ROCKETRIDE_MASKY_KEY', raising=False)
    monkeypatch.setenv('ROCKETRIDE_MASKY_API_KEY', 'oldkey')
    assert core.resolve_api_key(None) == ''


# ---------------------------------------------------------------------------
# 8. read_settings
# ---------------------------------------------------------------------------


def test_read_settings_defaults():
    s = IGlobalMod.read_settings({})
    assert s['action'] == 'talking_head'
    assert s['output'] == 'video'
    assert s['quality'] == '720p-draft'
    assert s['share'] == 'private'
    assert s['fps'] == 24
    assert s['duration_sec'] == 5
    assert s['seed'] is None
    assert s['server_name'] == 'masky'
    assert s['base_url'] == 'https://masky.ai/api'
    assert s['text_mode'] == 'literal'
    assert s['timeout_sec'] == 300
    assert s['poll_interval_sec'] == 3
    assert s['max_credits_per_call'] == 1.0
    assert s['include_media_urls'] is True


@pytest.mark.parametrize(
    'cfg',
    [
        {'action': 'dance'},
        {'share': 'none'},
        {'fps': 30},
        {'durationSec': 0},
        {'durationSec': 21},
        {'timeoutSec': 5},
        {'pollIntervalSec': 0},
        {'maxCreditsPerCall': -1},
    ],
)
def test_read_settings_rejects_bad_values(cfg):
    with pytest.raises(ValueError):
        IGlobalMod.read_settings(cfg)


@pytest.mark.parametrize('raw', ['nan', 'NaN', 'inf', '-inf', 'Infinity', float('nan'), float('inf'), float('-inf')])
def test_read_settings_rejects_non_finite_cap(raw):
    with pytest.raises(ValueError, match='finite'):
        IGlobalMod.read_settings({'maxCreditsPerCall': raw})


@pytest.mark.parametrize('raw', [True, False, 'abc', [1]])
def test_read_settings_rejects_non_numeric_cap(raw):
    with pytest.raises(ValueError):
        IGlobalMod.read_settings({'maxCreditsPerCall': raw})


@pytest.mark.parametrize(('raw', 'expected'), [(0, 0.0), ('0.07', 0.07), (2, 2.0), (None, 1.0), ('', 1.0)])
def test_read_settings_accepts_finite_cap(raw, expected):
    assert IGlobalMod.read_settings({'maxCreditsPerCall': raw})['max_credits_per_call'] == expected


# ---------------------------------------------------------------------------
# 9. config_warnings
# ---------------------------------------------------------------------------


def test_config_warnings_missing_key(monkeypatch):
    monkeypatch.delenv('ROCKETRIDE_MASKY_KEY', raising=False)
    msgs = IGlobalMod.config_warnings({})
    assert any('API key' in m for m in msgs)
    assert IGlobalMod.config_warnings({'apikey': KEY}) == []


def test_config_warnings_env_key_satisfies(monkeypatch):
    monkeypatch.setenv('ROCKETRIDE_MASKY_KEY', KEY)
    assert IGlobalMod.config_warnings({}) == []


@pytest.mark.parametrize(
    'action, warns', [('scene_video', True), ('image', True), ('talking_head', False), ('live', False)]
)
def test_config_warnings_source_image_url_by_action(action, warns):
    msgs = IGlobalMod.config_warnings({'apikey': KEY, 'action': action, 'sourceImageUrl': 'file:///tmp/a.png'})
    assert any('Source image URL' in m for m in msgs) is warns


def test_config_warnings_http_source_image_ok():
    cfg = {'apikey': KEY, 'action': 'image', 'sourceImageUrl': 'https://x.example/a.png'}
    assert IGlobalMod.config_warnings(cfg) == []


def test_config_warnings_long_speech_line():
    msgs = IGlobalMod.config_warnings({'apikey': KEY, 'speechLine': 'x' * 301})
    assert any('301' in m for m in msgs)
    assert IGlobalMod.config_warnings({'apikey': KEY, 'speechLine': 'x' * 300}) == []


def test_config_warnings_never_raises_on_bad_values():
    msgs = IGlobalMod.config_warnings({'apikey': KEY, 'fps': 30})
    assert msgs and 'fps' in msgs[0]
    assert IGlobalMod.config_warnings({'apikey': KEY, 'durationSec': 'abc'})


# ---------------------------------------------------------------------------
# 10. IGlobal lifecycle
# ---------------------------------------------------------------------------


def _iglobal(monkeypatch, open_mode, cfg):
    ig = IGlobalMod.IGlobal()
    ig.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode=open_mode))
    ig.glb = types.SimpleNamespace(logicalType='tool_masky', connConfig={})
    monkeypatch.setattr(IGlobalMod.Config, 'getNodeConfig', staticmethod(lambda *a, **k: cfg))
    return ig


def test_begin_global_config_mode_no_network_no_depends(stubs, http, monkeypatch):
    ig = _iglobal(monkeypatch, IGlobalMod.OPEN_MODE.CONFIG, {'apikey': KEY})
    ig.beginGlobal()
    assert ig.driver is None
    assert stubs.depends.calls == []
    assert http['calls'] == []


def test_begin_global_normal_mode_loads_depends_and_builds_driver(stubs, http, monkeypatch):
    ig = _iglobal(monkeypatch, IGlobalMod.OPEN_MODE.SOURCE, {'apikey': KEY, 'serverName': 'avatars'})
    ig.beginGlobal()
    assert len(stubs.depends.calls) == 1
    assert isinstance(ig.driver, MaskyDriver)
    assert [t['name'] for t in ig.driver._tool_query()][0] == 'avatars.list_avatars'
    assert ig.settings['action'] == 'talking_head'
    assert http['calls'] == []


def test_begin_global_config_mode_never_fetches_pricing(stubs, http, monkeypatch):
    """Opening the node's settings on the canvas (CONFIG mode) must make no network call, pricing included."""
    fetched = []
    monkeypatch.setattr(MaskyDriver, 'load_pricing', lambda self: fetched.append('pricing'))
    gets = []
    monkeypatch.setattr(sys.modules['requests'], 'get', lambda *a, **k: gets.append(a), raising=False)
    ig = _iglobal(monkeypatch, IGlobalMod.OPEN_MODE.CONFIG, {'apikey': KEY})
    ig.beginGlobal()
    assert fetched == [] and gets == [] and http['calls'] == []


def test_begin_global_normal_mode_fetches_pricing_once(stubs, http, monkeypatch):
    fetched = []
    monkeypatch.setattr(MaskyDriver, 'load_pricing', lambda self: fetched.append('pricing'))
    ig = _iglobal(monkeypatch, IGlobalMod.OPEN_MODE.SOURCE, {'apikey': KEY})
    ig.beginGlobal()
    assert fetched == ['pricing']


def test_begin_global_without_key_raises(stubs, monkeypatch):
    monkeypatch.delenv('ROCKETRIDE_MASKY_KEY', raising=False)
    ig = _iglobal(monkeypatch, IGlobalMod.OPEN_MODE.SOURCE, {})
    with pytest.raises(ValueError):
        ig.beginGlobal()
    assert ig.driver is None


def test_end_global_clears_client_key_and_driver(stubs, monkeypatch):
    ig = _iglobal(monkeypatch, IGlobalMod.OPEN_MODE.SOURCE, {'apikey': KEY})
    ig.beginGlobal()
    client = ig.driver._client
    assert client._api_key == KEY
    ig.endGlobal()
    assert client._api_key == ''
    assert ig.driver is None and ig.settings is None


# ---------------------------------------------------------------------------
# 11. services.json
# ---------------------------------------------------------------------------


def _load_services():
    lines = []
    for line in (_NODE_DIR / 'services.json').read_text(encoding='utf-8').split('\n'):
        if line.strip().startswith('//'):
            continue
        lines.append(line)
    return json.loads('\n'.join(lines))


def _shape_props(svc):
    return [p for section in svc['shape'] for p in section['properties'] if p != 'type']


def _conditional_props(svc):
    out = []
    for field in svc['fields'].values():
        for cond in field.get('conditional', []):
            out.extend(cond['properties'])
    return out


def test_services_shape_properties_exist_in_fields():
    svc = _load_services()
    for prop in _shape_props(svc):
        assert prop in svc['fields'], prop


def test_services_conditional_properties_exist_in_fields():
    svc = _load_services()
    for prop in _conditional_props(svc):
        assert prop in svc['fields'], prop


def test_services_preconfig_defaults_have_fields():
    svc = _load_services()
    profile = svc['preconfig']['profiles'][svc['preconfig']['default']]
    for key in profile:
        if key == 'title':
            continue
        assert f'tool_masky.{key}' in svc['fields'], key


def test_services_every_visible_field_is_reachable():
    svc = _load_services()
    reachable = set(_shape_props(svc)) | set(_conditional_props(svc))
    for name, field in svc['fields'].items():
        if field.get('hidden'):
            continue
        assert name in reachable, name


def test_begin_global_rejects_unfilled_key_placeholder(stubs, http, monkeypatch):
    """A ${ROCKETRIDE_MASKY_KEY} placeholder with no saved value must stop the node, not reach Masky as the key."""
    ig = _iglobal(monkeypatch, IGlobalMod.OPEN_MODE.SOURCE, {'apikey': '${ROCKETRIDE_MASKY_KEY}'})
    with pytest.raises(ValueError, match='unfilled placeholder'):
        ig.beginGlobal()
    assert ig.driver is None and http['calls'] == []


def test_validate_config_warns_on_unfilled_key_placeholder(stubs, monkeypatch):
    seen = []
    monkeypatch.setattr(IGlobalMod, 'warning', seen.append)
    ig = _iglobal(monkeypatch, IGlobalMod.OPEN_MODE.SOURCE, {'apikey': '${ROCKETRIDE_MASKY_KEY}'})
    ig.validateConfig()
    assert any('unfilled placeholder' in str(m) for m in seen)


# ---------------------------------------------------------------------------
# baseUrl: https only, plain http only for a parsed loopback hostname
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'url',
    [
        'https://masky.ai/api',
        'HTTPS://masky.ai/api',
        'https://staging.example.com/api',
        'http://localhost:8080/api',
        'http://LOCALHOST/api',
        'http://127.0.0.1:9000',
        'http://[::1]:9000/api',
    ],
)
def test_base_url_accepted(url):
    assert IGlobalMod.read_settings({'baseUrl': url})['base_url'] == url


@pytest.mark.parametrize(
    'url',
    [
        'http://masky.ai/api',
        'http://localhost.evil.com/api',
        'http://127.0.0.1.evil.com/api',
        'http://localhost@evil.com/api',
        'http://evil.com/?h=localhost',
        'ftp://localhost/api',
        'localhost/api',
        'https://',
        'http://[::1',
    ],
)
def test_base_url_refused(url):
    with pytest.raises(ValueError, match='https://'):
        IGlobalMod.read_settings({'baseUrl': url})


def test_default_base_url_is_https():
    assert IGlobalMod.read_settings({})['base_url'].startswith('https://')


# ---------------------------------------------------------------------------
# Permission switches: settings, services.json, warnings
# ---------------------------------------------------------------------------


def test_read_settings_permission_switches_default_off():
    s = IGlobalMod.read_settings({})
    assert (s['read_only'], s['allow_delete'], s['allow_public_sharing']) == (False, False, False)


@pytest.mark.parametrize(
    'raw,expected',
    [('true', True), ('false', False), ('True', True), (True, True), (False, False)],
)
def test_read_settings_permission_switches_parse(raw, expected):
    s = IGlobalMod.read_settings({'readOnly': raw, 'allowDelete': raw, 'allowPublicSharing': raw})
    assert (s['read_only'], s['allow_delete'], s['allow_public_sharing']) == (expected,) * 3


def test_services_permission_fields():
    svc = _load_services()
    expected = {
        'tool_masky.readOnly': 'Does not affect the pipeline action',
        'tool_masky.allowDelete': "Destructive: enable only when the agent is trusted to delete Masky conversations, turns and agent bindings. Deleted conversations can't be recovered.",
        'tool_masky.allowPublicSharing': 'Making something private is never gated',
    }
    for name, phrase in expected.items():
        field = svc['fields'][name]
        assert field['type'] == 'boolean', name
        assert field['default'] is False, name
        assert phrase in field['description'], name


def test_services_permission_fields_sit_between_language_and_max_credits():
    svc = _load_services()
    props = [p for section in svc['shape'] for p in section['properties']]
    i = props.index('tool_masky.language')
    j = props.index('tool_masky.maxCreditsPerCall')
    assert props[i + 1 : j] == ['tool_masky.readOnly', 'tool_masky.allowDelete', 'tool_masky.allowPublicSharing']


def test_services_default_profile_has_read_only_false():
    svc = _load_services()
    profile = svc['preconfig']['profiles'][svc['preconfig']['default']]
    assert profile['readOnly'] is False


_PUBLIC_WARNING = "'allowPublicSharing'"


def _public_warnings(cfg):
    return [m for m in IGlobalMod.config_warnings({'apikey': KEY, **cfg}) if _PUBLIC_WARNING in m]


def test_config_warns_for_public_scene_video_without_switch():
    assert len(_public_warnings({'action': 'scene_video', 'share': 'public'})) == 1


def test_config_no_public_warning_when_switch_on_private_or_other_action():
    assert _public_warnings({'action': 'scene_video', 'share': 'public', 'allowPublicSharing': 'true'}) == []
    assert _public_warnings({'action': 'scene_video', 'share': 'private'}) == []
    assert _public_warnings({'action': 'talking_head', 'share': 'public'}) == []
    assert _public_warnings({'action': 'image', 'share': 'public'}) == []
