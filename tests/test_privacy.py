"""Beweise für die „Einbahnstraße“: Wissen darf herein, private Daten nie hinaus.

Cloud (xKiro) und lokale KI (Ollama) werden simuliert; jeder Cloud-Aufruf wird mitgeschrieben,
damit die Tests zeigen können, dass private Inhalte dort NIE ankommen.
"""
import asyncio
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_jarvis  # gemeinsamer Test-Bootstrap
from jarvis import agents, brain, config, db, guard, knowledge, privacy, prompts, tools
from jarvis.errors import CloudUnavailable

ROOT = test_jarvis.ROOT


def run(coro):
    return asyncio.run(coro)


class Base(unittest.TestCase):
    def setUp(self):
        self._saved = {k: getattr(config, k) for k in ("PRIVACY", "XKIRO_API_KEY", "PROVIDER", "CLOUD_ENABLED",
                                                        "FALLBACK_LOCAL", "LEARN_FROM_CLOUD", "VISION_MODEL",
                                                        "HF_TOKEN", "ANTHROPIC_API_KEY")}
        config.PROVIDER, config.CLOUD_ENABLED, config.XKIRO_API_KEY = "xkiro", True, "sk-xt-test"
        config.HF_TOKEN, config.ANTHROPIC_API_KEY = "", ""
        config.FALLBACK_LOCAL, config.LEARN_FROM_CLOUD, config.VISION_MODEL = True, True, ""
        config.FALLBACK_STATUS.update(active=False, reason="", ts=0.0)
        config.OLLAMA_STATUS.update(ok=True, model_ok=True)
        for t in ("knowledge", "approvals"):
            db.ex(f"DELETE FROM {t}")
        db.ex("DELETE FROM memory")
        db.clear_history("priv")
        guard.set_stop(False)
        self.cloud, self.local = [], []
        self.cloud_reply = lambda msgs, n: {"message": {"content": "Antwort aus der Cloud " + "x" * 220, "tool_calls": []}}
        self.local_reply = lambda msgs, n: {"message": {"content": "Antwort der lokalen KI", "tool_calls": []}}

        async def fake_cloud(messages, tools=None, max_tokens=None, model=None, **kw):
            self.cloud.append(json.dumps(messages, ensure_ascii=False))
            return self.cloud_reply(messages, len(self.cloud))

        async def fake_local(messages, tools=None, max_tokens=None, model=None):
            self.local.append(json.dumps(messages, ensure_ascii=False))
            return self.local_reply(messages, len(self.local))
        self.p1 = patch("jarvis.xkiro.call", fake_cloud)
        self.p2 = patch.object(brain, "_ollama_call", fake_local)
        self.p1.start()
        self.p2.start()

    def tearDown(self):
        self.p1.stop()
        self.p2.stop()
        for k, v in self._saved.items():
            setattr(config, k, v)
        config.FALLBACK_STATUS.update(active=False, reason="", ts=0.0)

    def cloud_text(self):
        return "\n".join(self.cloud)


class StrictMode(Base):
    def test_strict_is_default_and_nothing_goes_to_cloud(self):
        os.environ.pop("JARVIS_PRIVACY", None)
        self.assertEqual(config.PRIVACY, self._saved["PRIVACY"])
        config.PRIVACY = "strikt"
        reply = run(brain.chat("priv", "Schreib mir eine Vertriebsstrategie für Solar."))
        self.assertEqual(reply, "Antwort der lokalen KI")
        self.assertEqual(self.cloud, [])

    def test_council_never_runs_in_strict(self):
        config.PRIVACY = "strikt"
        with patch.object(agents, "should_use_council", side_effect=AssertionError("darf nicht laufen")):
            self.assertEqual(run(agents.council("Sehr komplexe Strategieaufgabe " * 20)), "")


class SmartMode(Base):
    def setUp(self):
        super().setUp()
        config.PRIVACY = "smart"

    def test_public_question_may_use_cloud_and_is_learned(self):
        reply = run(brain.chat("priv", "Erkläre den Unterschied zwischen Festpreis- und dynamischem Stromtarif."))
        self.assertTrue(reply.startswith("Antwort aus der Cloud"))
        self.assertEqual(len(self.cloud), 1)
        self.assertEqual(knowledge.stats()["entries"], 1)  # Wissen ist HEREIN gekommen

    def test_private_tool_result_never_reaches_cloud(self):
        secret_dir = test_jarvis.TMP / "geheim"
        secret_dir.mkdir(exist_ok=True)
        (secret_dir / "Kontoauszug_Lisa.pdf").write_bytes(b"x")

        def cloud_reply(msgs, n):
            return {"message": {"content": "", "tool_calls": [
                {"id": "c1", "function": {"name": "list_dir", "arguments": {"path": str(secret_dir)}}}]}}
        self.cloud_reply = cloud_reply
        reply = run(brain.chat("priv", "Was liegt in meinem Ordner?"))
        self.assertEqual(reply, "Antwort der lokalen KI")
        self.assertEqual(len(self.cloud), 1)                   # nur die erste, noch nicht private Frage
        self.assertNotIn("Kontoauszug_Lisa", self.cloud_text())
        self.assertIn("Kontoauszug_Lisa", "\n".join(self.local))  # lokal verarbeitet
        # Gespräch bleibt privat: auch die nächste harmlose Frage geht nicht mehr in die Cloud
        run(brain.chat("priv", "Und wie wird das Wetter?"))
        self.assertEqual(len(self.cloud), 1)
        self.assertEqual(knowledge.stats()["entries"], 0)      # Privates wird nie „gelernt“

    def test_sensitive_user_text_stays_local_and_is_encrypted_at_rest(self):
        run(brain.chat("priv", "Schreib Herrn Weber zurück, seine Nummer ist +49 170 1234567."))
        self.assertEqual(self.cloud, [])
        raw = sqlite3.connect(config.DB_PATH).execute(
            "SELECT content, private FROM messages WHERE channel='priv' ORDER BY id").fetchall()
        self.assertTrue(raw and all(p == 1 and c.startswith("enc:v1:") for c, p in raw))
        self.assertNotIn("1234567", "".join(c for c, _ in raw))
        hist = db.history("priv", 5)
        self.assertIn("+49 170 1234567", hist[0]["content"])  # für Jarvis lesbar

    def test_explicit_private_prefix(self):
        run(brain.chat("priv", "/privat Was hältst du von meiner Idee?"))
        self.assertEqual(self.cloud, [])
        self.assertTrue(db.history("priv", 3)[0]["private"])

    def test_private_memory_only_in_local_prompt(self):
        run(tools.remember("Familie", "Schwester heißt Annika, Geburtstag 12.3.", privat=True))
        run(tools.remember("Firma", "TarifWerk berät zu Solar und Energie.", privat=False))
        raw = sqlite3.connect(config.DB_PATH).execute("SELECT content FROM memory WHERE private=1").fetchone()[0]
        self.assertTrue(raw.startswith("enc:v1:"))
        self.assertNotIn("Annika", prompts.system_prompt(local=False))
        self.assertIn("TarifWerk berät", prompts.system_prompt(local=False))
        self.assertIn("Annika", prompts.system_prompt(local=True))
        run(brain.chat("priv", "Was steht heute an?"))  # Cloud-Anfrage
        self.assertNotIn("Annika", self.cloud_text())

    def test_private_names_from_memory_block_teacher_and_search(self):
        run(tools.remember("Kontakt", "Lisa Brenner ist Kundin aus Mainz.", privat=True))
        out = run(tools.ask_teacher("Wie antworte ich Lisa höflich auf eine Beschwerde?"))
        self.assertIn("BLOCKIERT", out)
        self.assertEqual(self.cloud, [])
        res, err = run(tools.run_tool("web_search", {"query": "Lisa Brenner Mainz Telefon"}, {"private": True}))
        self.assertTrue(err)
        self.assertIn("BLOCKIERT", res)


class Teacher(Base):
    def setUp(self):
        super().setUp()
        config.PRIVACY = "strikt"

    def test_teacher_gets_only_the_question_and_knowledge_flows_in(self):
        self.cloud_reply = lambda msgs, n: {"message": {"content": "Eine Wärmepumpe nutzt Umweltwärme … " + "y" * 80}}
        out = run(tools.ask_teacher("Wie funktioniert eine Wärmepumpe im Altbau?"))
        self.assertIn("Wärmepumpe", out)
        sent = json.loads(self.cloud[0])
        self.assertEqual([m["role"] for m in sent], ["system", "user"])  # kein Verlauf, kein Gedächtnis
        self.assertEqual(sent[1]["content"], "Wie funktioniert eine Wärmepumpe im Altbau?")
        # Wissen ist jetzt Jarvis' eigenes – auch die lokale KI bekommt es mit
        run(brain.chat("priv", "Lohnt sich eine Wärmepumpe im Altbau?"))
        self.assertIn("Umweltwärme", self.local[-1])
        self.assertEqual(len(self.cloud), 1)

    def test_teacher_in_private_task_needs_owner_approval(self):
        out = run(tools.ask_teacher("Was ist ein Kapazitätsmarkt?", _ctx={"channel": "mission:1", "private": True}))
        self.assertIn("Freigabe", out)
        self.assertEqual(self.cloud, [])

        async def go():
            t = asyncio.create_task(test_jarvis.approve_later(True, match="Lehrer-Frage"))
            r = await tools.ask_teacher("Was ist ein Kapazitätsmarkt?", _ctx={"channel": "hud", "private": True})
            await t
            return r
        run(go())
        self.assertEqual(len(self.cloud), 1)

    def test_outbound_send_needs_approval_in_private_task(self):
        res, err = run(tools.run_tool("send_email", {"to": "x@y.de", "subject": "s", "body": "privat"},
                                      {"channel": "mission:2", "private": True}))
        self.assertTrue(err)
        self.assertIn("Freigabe", res)
        row = db.one("SELECT question, details FROM approvals ORDER BY id DESC")
        self.assertIn("send_email", row["question"])
        self.assertIn("privat", row["details"])  # Owner sieht genau, was hinausginge


class Robustness(Base):
    def test_local_down_means_blocked_not_cloud(self):
        config.PRIVACY = "strikt"

        async def broken(*a, **k):
            raise RuntimeError("Ollama ist nicht erreichbar.")
        with patch.object(brain, "_ollama_call", broken):
            reply = run(brain.chat("priv", "Wie geht es weiter?"))
        self.assertIn("Nichts wurde an eine Cloud gesendet", reply)
        self.assertEqual(self.cloud, [])

    def test_images_only_local(self):
        config.PRIVACY = "smart"
        txt = run(brain.describe_image("QUJD"))
        self.assertIn("kein Seh-Modell", txt)
        config.VISION_MODEL = "qwen3-vl:4b"
        run(brain.describe_image("QUJD"))
        self.assertEqual(self.cloud, [])
        self.assertIn("QUJD", self.local[-1])

    def test_outage_falls_back_to_local_in_smart_mode(self):
        config.PRIVACY = "smart"

        async def down(*a, **k):
            raise CloudUnavailable("xKiro überlastet")
        with patch("jarvis.xkiro.call", down):
            reply = run(brain.chat("priv", "Erkläre kurz Photovoltaik."))
        self.assertEqual(reply, "Antwort der lokalen KI")
        self.assertEqual(brain.LAST_PROVIDER["provider"], "ollama")

    def test_no_silent_local_fallback_when_disabled(self):
        config.PRIVACY, config.FALLBACK_LOCAL = "smart", False

        async def down(*a, **k):
            raise CloudUnavailable("xKiro überlastet")
        with patch("jarvis.xkiro.call", down):
            run(brain.chat("priv", "Erkläre kurz Photovoltaik."))
        self.assertEqual(self.local, [])


class HuggingFaceAndRemote(Base):
    def test_hf_can_be_teacher(self):
        config.PROVIDER, config.XKIRO_API_KEY, config.HF_TOKEN = "ollama", "", "hf_test"
        self.assertEqual(tools.teacher_provider(), "huggingface")

    def test_private_task_never_reaches_huggingface(self):
        config.PRIVACY, config.PROVIDER, config.HF_TOKEN = "smart", "huggingface", "hf_test"
        hf = []

        async def fake_hf(messages, tools=None, max_tokens=None, model=None, **kw):
            hf.append(json.dumps(messages, ensure_ascii=False))
            return {"message": {"content": "hf", "tool_calls": []}}
        with patch("jarvis.huggingface.call", fake_hf):
            reply = run(brain.chat("priv", "/privat Was steht in meinem Tagebuch über Lisa?"))
        self.assertEqual(hf, [])
        self.assertEqual(reply, "Antwort der lokalen KI")

    def test_github_remote_refuses_private_content(self):
        from jarvis import github_remote
        for task in ("/jarvis /privat meine Notizen", "/jarvis schreib an max@example.com",
                     "/jarvis ruf +49 170 1234567 an"):
            out = run(github_remote.run(task))
            self.assertIn("Abgelehnt", out, task)
        self.assertEqual(self.cloud, [])


class ServerMode(unittest.TestCase):
    def setUp(self):
        from starlette.testclient import TestClient
        from jarvis import web
        self.web = web
        self._old = (config.LOCAL, config.SERVER, config.JARVIS_PASSWORD)
        config.LOCAL, config.SERVER, config.JARVIS_PASSWORD = False, True, "richtig-langes-passwort"
        web._fails.clear()
        self.c = TestClient(web.app, base_url="http://127.0.0.1")

    def tearDown(self):
        config.LOCAL, config.SERVER, config.JARVIS_PASSWORD = self._old

    def test_login_lockout(self):
        self.assertEqual(self.c.get("/api/state").status_code, 401)
        h = {"X-Forwarded-For": "203.0.113.9"}
        for _ in range(5):
            self.assertEqual(self.c.post("/api/login", json={"password": "falsch"}, headers=h).status_code, 401)
        self.assertEqual(self.c.post("/api/login", json={"password": "richtig-langes-passwort"}, headers=h).status_code, 429)
        r = self.c.post("/api/login", json={"password": "richtig-langes-passwort"}, headers={"X-Forwarded-For": "198.51.100.7"})
        self.assertEqual(r.status_code, 200)
        auth = {"Authorization": "Bearer " + r.json()["token"], "X-Jarvis": "1"}
        self.assertEqual(self.c.get("/api/state", headers=auth).status_code, 200)

    def test_empty_password_never_works(self):
        config.JARVIS_PASSWORD = ""
        self.assertEqual(self.c.post("/api/login", json={"password": ""}).status_code, 401)


class DeployFiles(unittest.TestCase):
    def test_oracle_scripts(self):
        inst = (ROOT / "deploy" / "oracle" / "install.sh").read_text(encoding="utf-8")
        for needle in ("JARVIS_SERVER=1", "ProtectSystem=full", "OLLAMA_HOST=127.0.0.1:11434", "chown -R root:root",
                       'chmod 600 "$ENVF"', "tailscale", "JARVIS_PRIVACY", "backup.sh"):
            self.assertIn(needle, inst)
        self.assertNotIn("0.0.0.0", inst)
        upd = (ROOT / "deploy" / "oracle" / "update.sh").read_text(encoding="utf-8")
        self.assertIn('reset --hard "$OLD"', upd)
        bk = (ROOT / "deploy" / "oracle" / "backup.sh").read_text(encoding="utf-8")
        self.assertIn("openssl enc -aes-256-cbc -pbkdf2", bk)
        self.assertIn("--exclude=jarvis.key", bk)  # Schlüssel nie im selben Backup


if __name__ == "__main__":
    unittest.main(verbosity=2)
