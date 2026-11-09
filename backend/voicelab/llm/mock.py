"""A scripted "LLM" with configurable latency profiles.

Why it exists: it makes the whole lab usable with zero keys *and* lets you reproduce the
course's Lesson 5 experiment deterministically – `gpt-4o` ≈ 0.84 s TTFT vs `gpt-4o-mini` ≈ 0.42 s.
The two OpenAI numbers come from the course; the others are illustrative orders of magnitude.
It is a rule-based slot filler, not a language model – the label in the UI says so.
"""
from __future__ import annotations

import asyncio
import json
import random
import re
from collections.abc import AsyncIterator

from . import LLMEvent, ToolCall

PROFILES: dict[str, dict] = {
    "gpt-4o": {"ttft_ms": 840, "tps": 75, "note": "course measurement (Lesson 5)"},
    "gpt-4o-mini": {"ttft_ms": 420, "tps": 110, "note": "course measurement (Lesson 5)"},
    "fast-inference-70b": {"ttft_ms": 190, "tps": 400, "note": "illustrative (Groq/Cerebras class)"},
    "self-hosted-8b": {"ttft_ms": 600, "tps": 45, "note": "illustrative"},
    "slow-reasoning": {"ttft_ms": 1900, "tps": 60, "note": "illustrative (reasoning-class model)"},
}

NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
             "a couple": 2, "couple": 2}


def _party(text: str) -> int | None:
    m = re.search(r"(?:for|party of|table of|we(?:'| a)re|us)\s+(\d{1,2}|" + "|".join(k for k in NUM_WORDS if " " not in k) + r")\b(?:\s+(?:people|guests|of us|persons))?", text)
    if m:
        v = m.group(1)
        return int(v) if v.isdigit() else NUM_WORDS[v]
    m = re.search(r"\b(\d{1,2}|" + "|".join(k for k in NUM_WORDS if " " not in k) + r")\s+(?:people|guests|persons|of us)", text)
    if m:
        v = m.group(1)
        return int(v) if v.isdigit() else NUM_WORDS[v]
    return None


def _time(text: str) -> str | None:
    m = re.search(r"\b(?:at|around|for)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|p\.m\.|a\.m\.)\b", text)
    if m:
        return f"{m.group(1)}{':' + m.group(2) if m.group(2) else ''} {m.group(3).replace('.', '')}"
    m = re.search(r"\bat\s+(\d{1,2})(?::(\d{2}))?\b", text)
    if m:
        return f"{m.group(1)}{':' + m.group(2) if m.group(2) else ''}"
    words = "|".join(k for k in NUM_WORDS if " " not in k)
    m = re.search(rf"\b(?:at|around)\s+({words})(?:\s+(thirty|fifteen|forty five|o'?clock))?", text)
    if m:
        h = NUM_WORDS[m.group(1)]
        mins = {"thirty": ":30", "fifteen": ":15", "forty five": ":45"}.get(m.group(2) or "", "")
        return f"{h}{mins}"
    m = re.search(rf"\b({words})\s+(thirty|fifteen|forty five)\b", text)
    if m:
        mins = {"thirty": ":30", "fifteen": ":15", "forty five": ":45"}[m.group(2)]
        return f"{NUM_WORDS[m.group(1)]}{mins}"
    return None


def _name(text: str) -> str | None:
    m = re.search(r"(?:name is|it's|it is|under|this is|i'm|i am|call me)\s+([A-Z][a-z]+)", text)
    if m and m.group(1).lower() not in {"looking", "calling", "trying", "wondering"}:
        return m.group(1)
    m = re.fullmatch(r"\s*([A-Z][a-z]+(?: [A-Z][a-z]+)?)[.!]?\s*", text)
    return m.group(1) if m else None


MENU_TALK = (
    "Our menu is built around handmade pasta and wood fired pizza. "
    "The signature dish is the slow braised short rib ragu with fresh pappardelle. "
    "For starters, guests love the burrata with roasted tomatoes and the crispy artichokes. "
    "We also keep a short list of vegetarian and gluten free options on every night. "
    "Desserts are made in house, and the tiramisu is the one people come back for."
)


class MockLLM:
    def __init__(self, profile: str = "gpt-4o-mini", persona: str = "restaurant") -> None:
        self.profile_name = profile if profile in PROFILES else "gpt-4o-mini"
        self.profile = PROFILES[self.profile_name]
        self.name = "mock"
        self.model = f"{self.profile_name} (simulated)"
        self.persona = persona

    # --- dialogue brain -------------------------------------------------------------------
    def _decide(self, messages: list[dict]) -> tuple[str, ToolCall | None]:
        users = [m["content"] for m in messages if m["role"] == "user" and m.get("content")]
        last = (users[-1] if users else "").strip()
        low = last.lower()
        joined = " ".join(users)

        # a tool just returned -> narrate it
        if messages and messages[-1]["role"] == "tool":
            try:
                res = json.loads(messages[-1]["content"])
            except Exception:
                res = {}
            return self._narrate(res, messages), None

        if self.persona == "medical":
            return self._medical(users, low, messages)
        if self.persona in ("tutor", "support"):
            return self._generic(low), None
        return self._restaurant(users, last, low, joined, messages)

    def _restaurant(self, users, last, low, joined, messages):
        if re.search(r"\b(menu|dishes|what do you serve|recommend|specialt)", low):
            return MENU_TALK, None
        if re.search(r"\b(hours|open|close|closing)\b", low):
            return "We're open from five to ten every night. The kitchen takes its last order at nine thirty.", None
        party, time, name = _party(joined.lower()), _time(joined), None
        for u in users:
            name = _name(u) or name
        # remember what we've already done
        booked = any(m["role"] == "tool" and '"booked": true' in (m.get("content") or "").lower() for m in messages)
        checked = any(m["role"] == "tool" and "available" in (m.get("content") or "") for m in messages)
        if booked and not re.search(r"\b(change|another|new|again)\b", low):
            return "You're all set. Is there anything else I can help you with?", None
        if re.search(r"\b(book|reserve|reservation|table)\b", joined.lower()) or party or time:
            if not party:
                return "Happy to help with a table. How many people will be joining you?", None
            if not time:
                return f"Great, a table for {party}. What time would you like to come in?", None
            if not checked:
                return ("Let me check that for you.",
                        ToolCall("call_chk", "check_availability", {"party_size": party, "time": time}))
            if not name:
                return "We have space. May I have a name for the reservation?", None
            return ("Perfect, I'll book that now.",
                    ToolCall("call_bk", "book_table", {"party_size": party, "time": time, "name": name}))
        if re.search(r"\b(hi|hello|hey)\b", low) or not users:
            return "Hi there! I can book a table or answer questions about our menu. What would you like?", None
        return "I can help with reservations, opening hours, or the menu. What would you like to know?", None

    def _narrate(self, res: dict, messages: list[dict]) -> str:
        if "available" in res:
            if res["available"]:
                users = [m["content"] for m in messages if m["role"] == "user"]
                name = None
                for u in users:
                    name = _name(u) or name
                if name:
                    return "That time is open. Let me book it for you."
                return "Good news, that time is open. May I have a name for the reservation?"
            alt = res.get("next_available")
            tail = f" The next opening I have is at {alt}. Would that work?" if alt else " Would another time work?"
            return f"Sorry, that slot is full.{tail}"
        if "booked" in res:
            if res["booked"]:
                return (f"You're booked. Your confirmation code is {res.get('confirmation', '')}. "
                        "We look forward to seeing you. Is there anything else I can do?")
            return "I'm sorry, that table just filled up. Could you pick a different time?"
        if "urgency" in res:
            lvl = res["urgency"]
            if lvl == "emergency":
                return "Based on what you've told me, please call emergency services right now."
            return f"Thanks. I've marked this as {lvl}. A nurse will call you back shortly."
        if res.get("logged"):
            return "Thank you, I've noted that. On a scale of one to ten, how severe is it?"
        return "Okay, done. Anything else?"

    def _medical(self, users, low, messages):
        logged = sum(1 for m in messages if m["role"] == "tool" and "logged" in (m.get("content") or ""))
        sev = re.search(r"\b(\d{1,2})\b(?:\s*(?:out of|/)\s*10)?", low)
        if logged >= 1 and sev and any(m["role"] == "tool" for m in messages[-6:]) is False:
            return "Let me assess that.", ToolCall("call_u", "assess_urgency", {})
        if logged == 0 and len(low.split()) >= 3:
            symptom = re.sub(r"^(i have|i've got|i'm having|i am having|i'm feeling|i feel|i've been having)\s+", "", low).strip(" .")
            return ("Okay, let me note that down.",
                    ToolCall("call_s", "log_symptom", {"symptom": symptom or low, "duration": "", "severity": None}))
        if logged >= 1:
            return "Thanks. How long has this been going on, and how severe is it from one to ten?", None
        return "I'm here to help. What symptom are you experiencing?", None

    def _generic(self, low: str) -> str:
        if re.search(r"\b(hi|hello|hey)\b", low):
            return "Hello! It's great to hear from you. What would you like to talk about today?"
        if "?" in low or low.startswith(("what", "how", "why", "can")):
            return ("That's a really good question. Let me give you a short answer. "
                    "The key idea is to keep things simple and move one step at a time. "
                    "Would you like me to go into more detail?")
        return "Got it, thanks for sharing that. Could you tell me a little more?"

    # --- provider interface -----------------------------------------------------------------
    async def stream(self, messages, tools, *, temperature: float = 0.4, max_tokens: int = 220) -> AsyncIterator[LLMEvent]:
        jitter = random.uniform(0.85, 1.2)
        await asyncio.sleep(self.profile["ttft_ms"] * jitter / 1000)
        text, tool = self._decide(messages)
        tokens = re.findall(r"\S+\s*", text)
        per_tok = 1.0 / self.profile["tps"]
        n = 0
        for tok in tokens:
            n += 1
            yield LLMEvent("text", text=tok)
            await asyncio.sleep(per_tok * random.uniform(0.8, 1.2))
        if tool:
            yield LLMEvent("tool_call", tool=tool)
        prompt_tokens = int(sum(len((m.get("content") or "").split()) for m in messages) * 1.3)
        yield LLMEvent("usage", usage={"prompt_tokens": prompt_tokens, "completion_tokens": int(n * 1.3)})

    async def complete(self, messages, *, max_tokens: int = 8) -> str:
        await asyncio.sleep(self.profile["ttft_ms"] / 1000 * 0.6)
        return "YES"

    async def aclose(self) -> None:
        pass
