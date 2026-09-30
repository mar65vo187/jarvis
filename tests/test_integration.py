"""HTTP-level regressions for Claude, setup, tool execution and access control."""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Reuse the existing test bootstrap: no real user data or credentials are touched.
import test_jarvis
import httpx
from jarvis import brain, claude, config, db, guard, main, web, xkiro

REAL_CLIENT = httpx.AsyncClient


class Integration(unittest.TestCase):
    def setUp(self):
        self.env = dict(os.environ)
        self.tmp = tempfile.TemporaryDirectory()
        self.env_file = config.ENV_FILE
        config.ENV_FILE = Path(self.tmp.name) / '.env'
        os.environ['JARVIS_PROVIDER'] = 'auto'
        for key in ('ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'CLAUDE_DAILY_BUDGET_USD', 'CLAUDE_MODEL', 'CLAUDE_PRICE_IN', 'CLAUDE_PRICE_OUT',
                    'XKIRO_API_KEY', 'XKIRO_MODEL', 'XKIRO_REASONING_EFFORT', 'JARVIS_CLOUD_ENABLED'):
            os.environ.pop(key, None)
        config.reload()
        db.ex('DELETE FROM usage')
        db.clear_history('hud')
        db.ex('DELETE FROM approvals')
        guard.set_stop(False)
        db.set_setting('setup_done', '0')
        self.status = dict(config.CLAUDE_STATUS)
        self.xkiro_status = dict(config.XKIRO_STATUS)
        self.ollama = dict(config.OLLAMA_STATUS)
        self.hooks = list(web.NOTIFY_HOOKS)
        web.NOTIFY_HOOKS[:] = [web._notify_hook]
        claude._lock = asyncio.Lock()
        xkiro._lock = asyncio.Lock()
        brain._ollama_lock = asyncio.Lock()
        brain._locks.clear()

    def tearDown(self):
        web.NOTIFY_HOOKS[:] = self.hooks
        os.environ.clear()
        os.environ.update(self.env)
        config.ENV_FILE = self.env_file
        config.reload()
        config.CLAUDE_STATUS.clear()
        config.CLAUDE_STATUS.update(self.status)
        config.XKIRO_STATUS.clear()
        config.XKIRO_STATUS.update(self.xkiro_status)
        config.OLLAMA_STATUS.clear()
        config.OLLAMA_STATUS.update(self.ollama)
        self.tmp.cleanup()

    def provider(self):
        os.environ.update(JARVIS_PROVIDER='claude', ANTHROPIC_API_KEY='test-private-key')
        config.reload()

    def fake_api(self, handler):
        return patch.object(claude.httpx, 'AsyncClient', side_effect=lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(handler), **kw))

    def fake_xkiro_api(self, handler):
        return patch.object(xkiro.httpx, 'AsyncClient', side_effect=lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(handler), **kw))

    def client(self, host='127.0.0.1'):
        return REAL_CLIENT(transport=httpx.ASGITransport(app=web.app, client=('127.0.0.1', 1234)),
                           base_url=f'http://{host}:{config.PORT}', headers={'X-Jarvis': '1'})

    def test_claude_real_protocol_and_tool_execution(self):
        self.provider()
        target = Path(self.tmp.name) / 'result.txt'
        captured = []

        def respond(req):
            self.assertEqual(req.url.path, '/v1/messages')
            self.assertEqual(req.headers['x-api-key'], 'test-private-key')
            self.assertEqual(req.headers['anthropic-version'], '2023-06-01')
            payload = json.loads(req.content)
            captured.append(payload)
            self.assertNotIn('temperature', payload)
            self.assertTrue(payload['system'])
            self.assertIn('input_schema', payload['tools'][0])
            if len(captured) == 1:
                blocks = [{'type': 'text', 'text': 'Ich erstelle die Datei.'},
                          {'type': 'tool_use', 'id': 'toolu_write', 'name': 'write_file',
                           'input': {'path': str(target), 'content': 'Hallo Marvin'}}]
                reason = 'tool_use'
            else:
                previous = payload['messages'][-2]['content']
                self.assertEqual(previous[-1]['id'], 'toolu_write')
                result = payload['messages'][-1]['content'][0]
                self.assertEqual(result['type'], 'tool_result')
                self.assertEqual(result['tool_use_id'], 'toolu_write')
                self.assertIn('Gespeichert', result['content'])
                self.assertTrue(target.exists())
                blocks = [{'type': 'text', 'text': 'Datei angelegt und geprüft.'}]
                reason = 'end_turn'
            return httpx.Response(200, json={'content': blocks, 'stop_reason': reason,
                                             'usage': {'input_tokens': 50, 'output_tokens': 20}})

        with self.fake_api(respond):
            result = asyncio.run(brain.chat('hud', 'Erstelle eine Datei.'))
        self.assertEqual(result, 'Datei angelegt und geprüft.')
        self.assertEqual(target.read_text(), 'Hallo Marvin')
        self.assertEqual(len(captured), 2)
        self.assertGreater(db.cost_today(), 0)
        self.assertEqual(len(db.history('hud', 2)), 2)

    def test_parallel_tool_blocks_are_grouped_and_thinking_preserved(self):
        signed = {'type': 'thinking', 'thinking': 'reasoning', 'signature': 'signature-123'}
        blocks = [signed, {'type': 'tool_use', 'id': 'a', 'name': 'list_dir', 'input': {}},
                  {'type': 'tool_use', 'id': 'b', 'name': 'recall', 'input': {'query': 'x'}}]
        _, result = claude.messages_payload([
            {'role': 'user', 'content': 'x'},
            {'role': 'assistant', 'content': '', '_claude_content': blocks},
            {'role': 'tool', 'content': 'first', 'tool_call_id': 'a'},
            {'role': 'tool', 'content': 'second', 'tool_call_id': 'b', 'is_error': True},
        ])
        self.assertEqual(result[-2]['content'][0], signed)
        self.assertEqual([b['tool_use_id'] for b in result[-1]['content']], ['a', 'b'])
        self.assertTrue(result[-1]['content'][1]['is_error'])

    def test_claude_image_does_not_require_ollama_vision(self):
        self.provider()

        def respond(req):
            payload = json.loads(req.content)
            content = payload['messages'][0]['content']
            self.assertEqual(content[1]['source']['data'], 'AAAA')
            self.assertEqual(content[1]['type'], 'image')
            self.assertEqual(payload['model'], config.CLAUDE_MODEL)
            return httpx.Response(200, json={'content': [{'type': 'text', 'text': 'Ein Bild.'}], 'usage': {}})

        config.VISION_MODEL = ''
        with self.fake_api(respond):
            self.assertIn('Ein Bild.', asyncio.run(brain.describe_image('AAAA')))

    def test_missing_key_stops_before_network_call(self):
        os.environ['JARVIS_PROVIDER'] = 'claude'
        config.reload()
        with patch.object(claude.httpx, 'AsyncClient', side_effect=AssertionError('network must not be called')):
            result = asyncio.run(brain.chat('hud', 'Hallo'))
        self.assertIn('Anthropic-API-Schlüssel', result)
        self.assertFalse(asyncio.run(claude.check())['ok'])

    def test_daily_budget_prevents_request(self):
        self.provider()
        db.add_usage(0, 0, 0, 1.0)
        with patch.object(claude.httpx, 'AsyncClient', side_effect=AssertionError('network must not be called')):
            with self.assertRaises(brain.BudgetExceeded):
                asyncio.run(claude.call([{'role': 'user', 'content': 'x'}]))

    def test_http_auth_failure_is_clear_and_has_no_secret(self):
        self.provider()
        with self.fake_api(lambda req: httpx.Response(401, json={'error': {'message': 'test-private-key'}})):
            result = asyncio.run(brain.chat('hud', 'x'))
        self.assertIn('ungültig', result)
        self.assertNotIn('test-private-key', result)

    def test_unfinished_tool_call_is_never_executed(self):
        self.provider()
        target = Path(self.tmp.name) / 'must-not-exist'
        data = {'stop_reason': 'max_tokens', 'content': [
            {'type': 'tool_use', 'id': 'x', 'name': 'write_file', 'input': {'path': str(target), 'content': 'x'}}], 'usage': {}}
        with self.fake_api(lambda req: httpx.Response(200, json=data)):
            result = asyncio.run(brain.chat('hud', 'x'))
        self.assertIn('nicht ausgeführt', result)
        self.assertFalse(target.exists())

    def test_api_setup_saves_key_without_exposing_it(self):
        async def go():
            async with self.client() as client:
                with self.fake_api(lambda req: httpx.Response(200, json={'id': 'claude-sonnet-5-5'})):
                    result = await client.post('/api/setup', json={'JARVIS_PROVIDER': 'claude', 'ANTHROPIC_API_KEY': 'test-private-key'})
                self.assertEqual(result.status_code, 200)
                public = await client.get('/api/config')
                state = await client.get('/api/state')
                health = await client.get('/health')
                self.assertTrue(public.json()['claude_key_set'])
                self.assertEqual(state.json()['provider'], 'claude')
                self.assertTrue(health.json()['ai_ready'])
                for response in (result, public, state, health):
                    self.assertNotIn('test-private-key', response.text)
        asyncio.run(go())
        self.assertIn('test-private-key', config.ENV_FILE.read_text())
        self.assertEqual(config.active_provider(), 'claude')

    def test_invalid_setup_does_not_change_file(self):
        config.save_env({'OWNER_NAME': 'Marvin'})
        before = config.ENV_FILE.read_bytes()

        async def go():
            async with self.client() as client:
                response = await client.post('/api/setup', json={'JARVIS_PROVIDER': 'invented'})
                self.assertEqual(response.status_code, 400)
                response = await client.post('/api/setup', json={'CLAUDE_DAILY_BUDGET_USD': 'NaN'})
                self.assertEqual(response.status_code, 400)
        asyncio.run(go())
        self.assertEqual(config.ENV_FILE.read_bytes(), before)

    def test_malformed_requests_and_foreign_origins_are_blocked(self):
        async def go():
            async with self.client() as client:
                for data in ('{', 'null', '[]'):
                    self.assertEqual((await client.post('/api/chat', content=data)).status_code, 400)
                self.assertEqual((await client.post('/api/chat', json={'text': 4})).status_code, 400)
                self.assertEqual((await client.get('/api/state?since=invalid')).status_code, 400)
                self.assertEqual((await client.post('/api/setup', json={'OWNER_NAME': 'intruder'},
                                  headers={'Origin': 'https://foreign.example'})).status_code, 401)
            async with self.client('foreign.example') as client:
                self.assertEqual((await client.get('/api/config')).status_code, 400)
        asyncio.run(go())

    def test_app_starts_with_missing_provider_and_reports_real_status(self):
        async def go():
            async with self.client() as client:
                for path in ('/', '/icon.svg', '/manifest.json', '/sw.js', '/api/history'):
                    self.assertEqual((await client.get(path)).status_code, 200, path)
                self.assertEqual((await client.get('/health')).json()['app'], 'jarvis')
                self.assertEqual((await client.post('/api/notaus', json={'on': True})).status_code, 200)
                self.assertTrue((await client.get('/api/state')).json()['notaus'])
                await client.post('/api/notaus', json={'on': False})
        asyncio.run(go())

    def test_cloud_loopback_urls_and_quoted_env_roundtrip(self):
        for url in ('http://127.0.0.1:11434@evil.example', 'https://127.0.0.1:11434', 'http://localhost.evil:11434', 'http://127.0.0.1:bad'):
            with self.assertRaises(ValueError):
                config.validate_values({'OLLAMA_BASE_URL': url})
        value = 'Marvins "TarifWerk" \\ Wiesbaden'
        config.save_env({'OWNER_INFO': value})
        self.assertEqual(config.OWNER_INFO, value)

    def test_context_keeps_complete_tool_exchange(self):
        blocks = [{'type': 'tool_use', 'id': 'x', 'name': 'recall', 'input': {}}]
        messages = [{'role': 'system', 'content': 'System'}, {'role': 'user', 'content': 'old' * 12000},
                    {'role': 'assistant', 'content': 'old answer'}, {'role': 'user', 'content': 'current'},
                    {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'x', 'function': {'name': 'recall', 'arguments': {}}}], '_claude_content': blocks},
                    {'role': 'tool', 'tool_call_id': 'x', 'content': 'result'}]
        with patch.object(config, 'NUM_CTX', 4096):
            fitted = brain._fit_context(messages, [])
        self.assertEqual(fitted[1]['content'], 'current')
        _, converted = claude.messages_payload(fitted)
        self.assertEqual(converted[-1]['content'][0]['tool_use_id'], 'x')



    def test_xkiro_openai_protocol_and_cloud_lock(self):
        os.environ.update(JARVIS_PROVIDER='xkiro', JARVIS_CLOUD_ENABLED='1',
                          XKIRO_API_KEY='test-xkiro-key', XKIRO_MODEL='openai/gpt-5.6-sol')
        config.reload()
        seen = {'calls': 0}

        def respond(req):
            if req.url.path.endswith('/usage'):
                self.assertEqual(req.headers.get('authorization'), 'Bearer test-xkiro-key')
                return httpx.Response(200, json={'free_tokens': {'remaining': 123},
                                                 'wallet': {'balance_usd': '0.000000'}})
            if req.url.path.endswith('/models'):
                return httpx.Response(200, json={'data': [{'id': 'openai/gpt-5.6-sol'},
                                                           {'id': 'z-ai/glm-5.2'}]})
            self.assertTrue(req.url.path.endswith('/chat/completions'))
            payload = json.loads(req.content)
            self.assertEqual(payload['model'], 'openai/gpt-5.6-sol')
            self.assertTrue(payload.get('tools'))
            seen['calls'] += 1
            if seen['calls'] == 1:
                return httpx.Response(200, json={'choices': [{'finish_reason': 'tool_calls', 'message': {
                    'role': 'assistant', 'content': None, 'tool_calls': [{
                        'id': 'call_1', 'type': 'function',
                        'function': {'name': 'list_dir', 'arguments': '{}'}
                    }]}}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 4}})
            self.assertEqual(payload['messages'][-1]['role'], 'tool')
            self.assertEqual(payload['messages'][-1]['tool_call_id'], 'call_1')
            return httpx.Response(200, json={'choices': [{'finish_reason': 'stop',
                'message': {'role': 'assistant', 'content': 'xKiro bereit.'}}],
                'usage': {'prompt_tokens': 12, 'completion_tokens': 3}})

        with self.fake_xkiro_api(respond):
            status = asyncio.run(xkiro.check())
            self.assertTrue(status['ok'])
            self.assertTrue(status['model_ok'])
            answer = asyncio.run(brain.think(
                [{'role': 'user', 'content': 'Liste Dateien.'}], {'channel': 'hud'}, max_steps=3))
        self.assertEqual(answer, 'xKiro bereit.')
        self.assertEqual(seen['calls'], 2)

        os.environ['JARVIS_CLOUD_ENABLED'] = '0'
        config.reload()
        self.assertEqual(config.active_provider(), 'ollama')

    def test_auto_prefers_xkiro_then_claude_then_local(self):
        os.environ.update(JARVIS_PROVIDER='auto', JARVIS_CLOUD_ENABLED='1',
                          XKIRO_API_KEY='x', ANTHROPIC_API_KEY='a')
        config.reload()
        self.assertEqual(config.active_provider(), 'xkiro')
        os.environ.pop('XKIRO_API_KEY')
        config.reload()
        self.assertEqual(config.active_provider(), 'claude')
        os.environ.pop('ANTHROPIC_API_KEY')
        config.reload()
        self.assertEqual(config.active_provider(), 'ollama')

if __name__ == '__main__':
    unittest.main()
