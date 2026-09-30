"""Regression tests for Jarvis' advisory multi-agent council."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import test_jarvis  # bootstrap isolated DATA_DIR / environment
from jarvis import agents, brain, config, db, xkiro


CATALOG = [
    {"id": "openai/gpt-5.6-sol", "owned_by": "openai", "access_tier": "paid",
     "context_length": 200000, "capabilities": {"reasoning": True, "tools": True, "vision": True},
     "reasoning_efforts": {"levels": ["low", "medium", "high"], "default": "medium"}},
    {"id": "anthropic/claude-test", "owned_by": "anthropic", "access_tier": "paid",
     "context_length": 200000, "capabilities": {"reasoning": True, "tools": True, "vision": True},
     "reasoning_efforts": {"levels": ["low", "high"], "default": "high"}},
    {"id": "google/gemini-test", "owned_by": "google", "access_tier": "free",
     "context_length": 1000000, "capabilities": {"reasoning": True, "tools": True, "vision": True},
     "reasoning_efforts": {"levels": ["low", "high"], "default": "high"}},
    {"id": "qwen/qwen-test", "owned_by": "qwen", "access_tier": "free",
     "context_length": 262144, "capabilities": {"reasoning": False, "tools": True, "vision": True}},
    {"id": "deepseek/deepseek-test", "owned_by": "deepseek", "access_tier": "free",
     "context_length": 128000, "capabilities": {"reasoning": True, "tools": False, "vision": False},
     "reasoning_efforts": {"levels": ["high"], "default": "high"}},
    {"id": "z-ai/glm-test", "owned_by": "z-ai", "access_tier": "free",
     "context_length": 200000, "capabilities": {"reasoning": True, "tools": True, "vision": False},
     "reasoning_efforts": {"levels": ["low", "high"], "default": "high"}},
    {"id": "minimax/minimax-test", "owned_by": "minimax", "access_tier": "paid",
     "context_length": 200000, "capabilities": {"reasoning": True, "tools": True, "vision": False}},
    {"id": "x-ai/grok-premium", "owned_by": "x-ai", "access_tier": "premium",
     "context_length": 200000, "capabilities": {"reasoning": True, "tools": True, "vision": False}},
]


class AgentCouncil(unittest.TestCase):
    def setUp(self):
        self.last = dict(agents.LAST_RUN)
        db.clear_history("agent-test")

    def tearDown(self):
        agents.LAST_RUN.clear()
        agents.LAST_RUN.update(self.last)
        db.clear_history("agent-test")

    def test_auto_mode_only_uses_council_for_complex_tasks(self):
        with patch.object(config, "AGENTS_ENABLED", True),              patch.object(config, "AGENT_MODE", "auto"),              patch.object(config, "XKIRO_API_KEY", "x"),              patch.object(config, "active_provider", return_value="xkiro"):
            self.assertFalse(agents.should_use_council("Hallo Jarvis"))
            self.assertTrue(agents.should_use_council("Analysiere die Architektur und optimiere mein GitHub-System."))

    def test_premium_models_are_filtered_by_default(self):
        with patch.object(config, "AGENT_ALLOW_PREMIUM", False),              patch.object(config, "AGENT_PREFER_FREE", False):
            ranked = agents.rank_models(agents.SPECS["engineer"], CATALOG)
        self.assertTrue(ranked)
        self.assertNotIn("x-ai/grok-premium", [row["id"] for row in ranked])

    def test_business_council_uses_distinct_specialists_and_web_research(self):
        calls = []

        async def fake_call(messages, tools=None, max_tokens=None, model=None,
                            reasoning_effort=None, web_search=False):
            calls.append({"model": model, "tools": tools, "web_search": web_search,
                          "reasoning": reasoning_effort, "messages": messages})
            return {"message": {"content": f"Beratung von {model}"}}

        settings = [
            patch.object(config, "AGENTS_ENABLED", True),
            patch.object(config, "AGENT_MODE", "always"),
            patch.object(config, "AGENT_MAX_AGENTS", 5),
            patch.object(config, "AGENT_MAX_PARALLEL", 4),
            patch.object(config, "AGENT_MAX_TOKENS", 700),
            patch.object(config, "AGENT_MODEL_FALLBACKS", 1),
            patch.object(config, "AGENT_PREFER_FREE", False),
            patch.object(config, "AGENT_ALLOW_PREMIUM", False),
            patch.object(config, "XKIRO_API_KEY", "x"),
            patch.object(config, "active_provider", return_value="xkiro"),
            patch.object(xkiro, "list_model_details", new=AsyncMock(return_value=CATALOG)),
            patch.object(xkiro, "call", new=fake_call),
        ]
        for p in settings:
            p.start()
        try:
            result = asyncio.run(agents.council(
                "Entwickle eine Vertriebsstrategie, analysiere Markt, Kunden und Preis und recherchiere aktuelle Optionen."
            ))
        finally:
            for p in reversed(settings):
                p.stop()

        self.assertIn("MULTI-AGENTENRAT", result)
        self.assertEqual(len(calls), 5)
        self.assertEqual(len({c["model"] for c in calls}), 5)
        self.assertTrue(any(c["web_search"] for c in calls))
        self.assertTrue(all(c["tools"] is None for c in calls))
        self.assertTrue(agents.LAST_RUN["used"])

    def test_master_receives_council_as_context_but_keeps_execution(self):
        think = AsyncMock(return_value="Master-Ergebnis")
        council = AsyncMock(return_value="MULTI-AGENTENRAT: geprüft")
        with patch.object(brain.agents, "council", new=council), patch.object(brain, "think", new=think):
            result = asyncio.run(brain.chat("agent-test", "Baue und prüfe das System."))
        self.assertEqual(result, "Master-Ergebnis")
        self.assertEqual(think.await_args.kwargs["extra_system"], "MULTI-AGENTENRAT: geprüft")
        council.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
