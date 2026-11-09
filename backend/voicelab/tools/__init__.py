"""Agent tools (Lesson 1: "reliable tool execution to prevent overbooking").

Each session owns a `ToolBox` with its own in-memory state, so the restaurant really can run out
of tables for a time slot and the agent has to cope with a tool returning "unavailable".
"""
from __future__ import annotations

import asyncio
import random
import re
from typing import Any

SLOT_CAPACITY = 2  # tables per time slot – small on purpose so overbooking is easy to provoke


def _norm_time(t: str) -> str:
    """'7', '7pm', '19:00', 'seven thirty' -> '19:00' style key (best effort)."""
    t = t.strip().lower()
    m = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$", t)
    if m:
        h, mm, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3)
        if ap == "pm" and h < 12:
            h += 12
        if ap is None and 1 <= h <= 10:
            h += 12  # dinner default
        return f"{h:02d}:{mm:02d}"
    return t


_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}


def _as_int(v: Any) -> int:
    """LLMs happily send "4", 4.0 or "four" for an integer parameter – be liberal in what you accept."""
    if isinstance(v, (int, float)):
        return int(v)
    t = str(v).strip().lower()
    if t in _WORDS:
        return _WORDS[t]
    m = re.search(r"\d+", t)
    return int(m.group()) if m else 0


TOOL_SCHEMAS: dict[str, dict] = {
    "check_availability": {
        "type": "function",
        "function": {
            "name": "check_availability",
            "description": "Check whether the restaurant has a free table for a party at a time today.",
            "parameters": {
                "type": "object",
                "properties": {
                    "party_size": {"type": "integer", "description": "Number of guests"},
                    "time": {"type": "string", "description": "Time such as '7 pm' or '19:30'"},
                },
                "required": ["party_size", "time"],
            },
        },
    },
    "book_table": {
        "type": "function",
        "function": {
            "name": "book_table",
            "description": "Book a table. Only call after check_availability says it is available.",
            "parameters": {
                "type": "object",
                "properties": {
                    "party_size": {"type": "integer"},
                    "time": {"type": "string"},
                    "name": {"type": "string", "description": "Name for the reservation"},
                },
                "required": ["party_size", "time", "name"],
            },
        },
    },
    "get_menu": {
        "type": "function",
        "function": {
            "name": "get_menu",
            "description": "Look up what the kitchen serves. Optionally filter by dietary need.",
            "parameters": {
                "type": "object",
                "properties": {"dietary": {"type": "string", "description": "vegetarian, gluten_free or empty for everything"}},
            },
        },
    },
    "log_symptom": {
        "type": "function",
        "function": {
            "name": "log_symptom",
            "description": "Record a symptom the caller reported, with duration and severity 1-10.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symptom": {"type": "string"},
                    "duration": {"type": "string"},
                    "severity": {"type": "integer"},
                },
                "required": ["symptom"],
            },
        },
    },
    "assess_urgency": {
        "type": "function",
        "function": {
            "name": "assess_urgency",
            "description": "Return a triage urgency level for the logged symptoms.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
}

PERSONA_TOOLS = {
    "restaurant": ["get_menu", "check_availability", "book_table"],
    "medical": ["log_symptom", "assess_urgency"],
    "tutor": [],
    "support": [],
}


class ToolBox:
    def __init__(self) -> None:
        self.bookings: dict[str, list[dict]] = {}
        self.symptoms: list[dict] = []

    def schemas(self, persona: str) -> list[dict]:
        return [TOOL_SCHEMAS[n] for n in PERSONA_TOOLS.get(persona, [])]

    async def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(random.uniform(0.08, 0.22))  # a "database round trip"
        fn = getattr(self, f"_t_{name}", None)
        if not fn:
            return {"error": f"unknown tool {name}"}
        try:
            return fn(**args)
        except TypeError as e:
            return {"error": f"bad arguments: {e}"}

    def _t_check_availability(self, party_size: int, time: str) -> dict:
        party_size = _as_int(party_size)
        key = _norm_time(str(time))
        taken = len(self.bookings.get(key, []))
        if party_size > 8:
            return {"available": False, "reason": "parties over 8 need a phone reservation"}
        if taken >= SLOT_CAPACITY:
            alt = next((k for k in ("18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00")
                        if len(self.bookings.get(k, [])) < SLOT_CAPACITY and k != key), None)
            return {"available": False, "reason": "slot is full", "next_available": alt}
        return {"available": True, "time": key, "tables_left": SLOT_CAPACITY - taken}

    def _t_book_table(self, party_size: int, time: str, name: str) -> dict:
        party_size = _as_int(party_size)
        key = _norm_time(str(time))
        slot = self.bookings.setdefault(key, [])
        if len(slot) >= SLOT_CAPACITY:
            return {"booked": False, "reason": "overbooking prevented – slot filled just now"}
        slot.append({"name": name, "party_size": party_size})
        return {"booked": True, "confirmation": f"VL{random.randint(1000, 9999)}", "time": key, "name": name,
                "party_size": party_size}

    MENU = [
        {"dish": "Short rib ragu with pappardelle", "tags": []},
        {"dish": "Wood fired margherita pizza", "tags": ["vegetarian"]},
        {"dish": "Burrata with roasted tomatoes", "tags": ["vegetarian", "gluten_free"]},
        {"dish": "Mushroom risotto", "tags": ["vegetarian", "gluten_free"]},
        {"dish": "Gluten free penne arrabbiata", "tags": ["vegetarian", "gluten_free"]},
        {"dish": "Grilled branzino", "tags": ["gluten_free"]},
        {"dish": "Tiramisu", "tags": ["vegetarian"]},
    ]

    def _t_get_menu(self, dietary: str = "") -> dict:
        d = (dietary or "").lower().replace(" ", "_").replace("-", "_")
        items = [m["dish"] for m in self.MENU if not d or d in m["tags"]]
        return {"filter": d or "all", "dishes": items}

    def _t_log_symptom(self, symptom: str, duration: str = "", severity: int | None = None) -> dict:
        severity = _as_int(severity) if severity not in (None, "") else None
        self.symptoms.append({"symptom": symptom, "duration": duration, "severity": severity})
        return {"logged": True, "count": len(self.symptoms)}

    def _t_assess_urgency(self) -> dict:
        worst = max((s.get("severity") or 0 for s in self.symptoms), default=0)
        text = " ".join(s["symptom"].lower() for s in self.symptoms)
        red = any(k in text for k in ("chest", "breath", "faint", "stroke", "bleeding"))
        level = "emergency" if red or worst >= 9 else "urgent" if worst >= 6 else "routine"
        return {"urgency": level, "symptoms_logged": len(self.symptoms)}
