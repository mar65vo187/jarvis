"""Regressions for model pool, agent evolution and remote/watchdog channels."""
import asyncio
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import test_jarvis
from jarvis import config, db, model_pool, upgrades

ROOT = Path(__file__).resolve().parent.parent

ROWS = [
    {"id":"local-test:latest","source":"ollama","owned_by":"local-test","access_tier":"local",
     "context_length":32768,"capabilities":{"reasoning":True,"tools":True,"vision":False}},
    {"id":"judge/test","source":"xkiro","owned_by":"openai","access_tier":"free",
     "context_length":131072,"capabilities":{"reasoning":True,"tools":True,"vision":False},
     "reasoning_efforts":{"levels":["high"]}},
]


class Ultra(unittest.TestCase):
    def setUp(self):
        db.ex("DELETE FROM agent_profiles")
        db.ex("DELETE FROM upgrade_runs")
        db.ex("DELETE FROM model_metrics")
        db.set_setting("upgrade_focus_index", "0")
        db.set_setting("upgrade_last_ts", "0")
        upgrades.LAST.update(running=False, ts=0.0, status="test", focus="", score=0.0, candidate="")

    def tearDown(self):
        db.ex("DELETE FROM agent_profiles")
        db.ex("DELETE FROM upgrade_runs")
        db.ex("DELETE FROM model_metrics")

    def test_model_metrics_affect_reliability(self):
        self.assertAlmostEqual(model_pool.reliability("ollama", "x"), 0.5)
        model_pool.record("ollama", "x", True, 10)
        model_pool.record("ollama", "x", True, 20)
        model_pool.record("ollama", "x", False, 30)
        self.assertGreater(model_pool.reliability("ollama", "x"), 0.5)

    def test_upgrade_promotes_only_benchmarked_child(self):
        judge_calls = {"n": 0}

        async def fake_call(row, messages, max_tokens, reasoning_effort="", web_search=False):
            system = messages[0]["content"]
            if "AGENT FACTORY" in system:
                return {"message":{"content":
                    '{"name":"CODE_SENTINEL","mission":"Prüfe technische Pläne systematisch auf Ursachen, Reproduzierbarkeit, Tests, Rollback, Race Conditions, Seiteneffekte, Observability und messbare Erfolgskriterien. Trenne Fakten von Annahmen und liefere priorisierte, reversible Umsetzungsschritte mit konkreter Verifikation.","vendors":["openai","z-ai"],"reasoning":true,"web_search":false}'}}
            if "Benchmark-Judge" in system:
                judge_calls["n"] += 1
                # child is B in task 1, A in task 2 => child wins both
                return {"message":{"content": '{"winner":"B","reason":"besser"}' if judge_calls["n"] == 1
                                               else '{"winner":"A","reason":"besser"}'}}
            return {"message":{"content":"Robuste Benchmark-Antwort mit Tests, Rollback und Verifikation."}}

        def fake_best(rows, free_only=False, exclude=None):
            return ROWS[1] if exclude else ROWS[0]

        with patch.object(model_pool, "catalog", new=AsyncMock(return_value=ROWS)), \
             patch.object(model_pool, "call", new=fake_call), \
             patch.object(model_pool, "best", side_effect=fake_best), \
             patch.object(config, "UPGRADE_BENCH_TASKS", 2), \
             patch.object(config, "UPGRADE_MAX_CHILDREN", 12), \
             patch.object(config, "UPGRADE_FREE_ONLY", True), \
             patch.object(config, "AGENT_MAX_TOKENS", 1200):
            result = asyncio.run(upgrades.run_cycle("code", manual=False))
        self.assertIn("Child-Agent aktiviert", result)
        row = db.one("SELECT * FROM agent_profiles WHERE status='active'")
        self.assertIsNotNone(row)
        self.assertEqual(row["task_type"], "code")
        self.assertEqual(row["generation"], 1)
        self.assertGreaterEqual(row["score"], 60)

    def test_watchdog_and_owner_only_github_remote_exist(self):
        self.assertTrue((ROOT / "Jarvis-Watchdog.pyw").exists())
        installer = (ROOT / "windows" / "install.ps1").read_text(encoding="utf-8")
        self.assertIn("Jarvis-Watchdog.pyw", installer)
        wf = (ROOT / ".github" / "workflows" / "jarvis-remote.yml").read_text(encoding="utf-8")
        self.assertIn("github.actor == github.repository_owner", wf)
        self.assertIn("startsWith(github.event.comment.body, '/jarvis ')", wf)
        self.assertIn("secrets.XKIRO_API_KEY", wf)
        self.assertIn("secrets.HF_TOKEN", wf)


if __name__ == "__main__":
    unittest.main()
