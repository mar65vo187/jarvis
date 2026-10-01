"""Gemeinsame Fehlertypen der KI-Anbieter."""


class BudgetExceeded(RuntimeError):
    """Cloud-Tagesbudget erreicht."""


class CloudUnavailable(RuntimeError):
    """Cloud-KI vorübergehend nicht nutzbar (Netz, Zeitlimit, Überlastung, Anfragelimit, Guthaben)
    → lokaler Ersatz möglich."""


class CloudConfigError(RuntimeError):
    """Einrichtungsfehler (Schlüssel fehlt/ungültig, Modell unbekannt) → KEIN stiller Wechsel,
    der Owner soll es sehen und beheben."""


class PrivacyBlocked(RuntimeError):
    """Private Daten dürfen nicht an eine Cloud-KI – und die lokale KI ist gerade nicht bereit."""
