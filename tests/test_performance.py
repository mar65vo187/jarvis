import asyncio
import unittest
from unittest.mock import patch

import test_jarvis
from jarvis import brain, config, db, performance


class Performance(unittest.TestCase):
    def setUp(self):
        db.ex("DELETE FROM runtime_metrics")
        db.set_setting("runtime_fast_model", "")
        db.set_setting("runtime_deep_model", "")
        self.saved = {k: getattr(config, k) for k in (
            "FAST_MODEL", "DEEP_MODEL", "MODEL", "THINK", "ADAPTIVE_THINK", "PERFORMANCE_TUNE",
            "FAST_MAX_TOKENS", "BALANCED_MAX_TOKENS", "DEEP_MAX_TOKENS",
            "FAST_TARGET_MS", "BALANCED_TARGET_MS", "DEEP_TARGET_MS")}

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(config, k, v)
        db.ex("DELETE FROM runtime_metrics")
        db.set_setting("runtime_fast_model", "")
        db.set_setting("runtime_deep_model", "")

    def test_profiles_spend_compute_only_on_complex_tasks(self):
        self.assertEqual(performance.profile_text("Hallo").name, "fast")
        p = performance.profile_text("Erkläre mir kurz, wie Solarstrom gespeichert wird.")
        self.assertIn(p.name, ("fast", "balanced"))
        deep = performance.profile_text("Analysiere und optimiere diese Python-Architektur, finde Race Conditions, benchmarke Alternativen und plane den Deploy mit Rollback.")
        self.assertEqual(deep.name, "deep")
        self.assertTrue(deep.think)

    def test_model_routing_uses_fast_and_deep_models(self):
        config.MODEL = "balanced:1"
        config.FAST_MODEL = "fast:1"
        config.DEEP_MODEL = "deep:1"
        self.assertEqual(performance.model_for(performance.profile_text("Hallo")), "fast:1")
        self.assertEqual(performance.model_for(performance.profile_text("Analysiere Architektur und benchmarke Performance")), "deep:1")

    def test_explicit_think_overrides_adaptive_policy(self):
        config.ADAPTIVE_THINK = True
        config.THINK = False
        self.assertFalse(performance.should_think(performance.profile_text("Hallo")))
        self.assertTrue(performance.should_think(performance.profile_text("Analysiere Architektur und benchmarke Performance")))
        config.THINK = True
        self.assertTrue(performance.should_think(performance.profile_text("Hallo")))

    def test_tuner_prefers_fastest_reliable_fast_model(self):
        config.PERFORMANCE_TUNE = True
        fast = performance.RuntimeProfile("fast", False, 100, 1000)
        for _ in range(4):
            performance.record("slow:1", fast, True, 900)
            performance.record("quick:1", fast, True, 250)
        performance.tune_from_history()
        self.assertEqual(db.get_setting("runtime_fast_model", ""), "quick:1")

    def test_tuner_does_not_promote_unreliable_model(self):
        config.PERFORMANCE_TUNE = True
        fast = performance.RuntimeProfile("fast", False, 100, 1000)
        for ok in (True, False, False, False, False):
            performance.record("flaky:1", fast, ok, 50)
        performance.tune_from_history()
        self.assertNotEqual(db.get_setting("runtime_fast_model", ""), "flaky:1")

    def test_brain_routes_simple_and_deep_requests_to_different_local_models(self):
        config.MODEL = "balanced:1"
        config.FAST_MODEL = "fast:1"
        config.DEEP_MODEL = "deep:1"
        seen = []

        async def fake_request(messages, tools=None, max_tokens=None, model=None, profile=None):
            seen.append((model, profile.name, performance.should_think(profile)))
            return {"message": {"content": "ok", "tool_calls": []}}

        async def run():
            with patch.object(brain, "_ollama_request", new=fake_request):
                await brain._ollama_call([{"role":"user","content":"Hallo"}])
                await brain._ollama_call([{"role":"user","content":"Analysiere Architektur, benchmarke Performance und prüfe Security, Race Conditions und Deploy-Risiken."}])
        asyncio.run(run())
        self.assertEqual(seen[0], ("fast:1", "fast", False))
        self.assertEqual(seen[1], ("deep:1", "deep", True))

    def test_missing_fast_model_falls_back_to_balanced_model(self):
        config.MODEL = "balanced:1"
        config.FAST_MODEL = "fast:missing"
        calls = []

        async def fake_request(messages, tools=None, max_tokens=None, model=None, profile=None):
            calls.append(model)
            if model == "fast:missing":
                raise RuntimeError("Ollama-Modell 'fast:missing' fehlt.")
            return {"message": {"content": "ok", "tool_calls": []}}

        async def run():
            with patch.object(brain, "_ollama_request", new=fake_request):
                return await brain._ollama_call([{"role":"user","content":"Hallo"}])
        out = asyncio.run(run())
        self.assertEqual((out.get("message") or {}).get("content"), "ok")
        self.assertEqual(calls, ["fast:missing", "balanced:1"])


if __name__ == "__main__":
    unittest.main()
